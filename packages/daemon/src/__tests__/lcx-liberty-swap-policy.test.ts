/**
 * LCX Liberty DEX policy parity tests.
 *
 * Resolves the same swaps through lcx_liberty_swap and zerox_swap (mocked APIs),
 * then evaluates every returned ContractCallRequest with the real
 * DatabasePolicyEngine + SettingsService. The new provider must get exactly the
 * same outcome as 0x in every case: no extra trust, no skipped check.
 *
 * 1. Opt-in: not registered with default settings
 * 2. Provider-trust auto-tag via executeResolve()
 * 3. CONTRACT_WHITELIST trust follows the enabled toggle, as for 0x
 * 4. SPENDING_LIMIT sees the native value of a swap, as for 0x
 * 5. METHOD_WHITELIST still applies to the router, as for 0x
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { encodeFunctionData } from 'viem';
import { registerBuiltInProviders, LCX_ROUTER_ABI } from '@waiaas/actions';
import type { ActionContext, ContractCallRequest } from '@waiaas/core';
import { createDatabase, pushSchema } from '../infrastructure/database/index.js';
import type { DatabaseConnection } from '../infrastructure/database/index.js';
import { wallets, policies } from '../infrastructure/database/schema.js';
import { generateId } from '../infrastructure/database/id.js';
import { DatabasePolicyEngine } from '../pipeline/database-policy-engine.js';
import { buildTransactionParam } from '../pipeline/pipeline-helpers.js';
import { SettingsService } from '../infrastructure/settings/settings-service.js';
import { DaemonConfigSchema } from '../infrastructure/config/loader.js';
import { ActionProviderRegistry } from '../infrastructure/action/action-provider-registry.js';

// ---------------------------------------------------------------------------
// Constants + mocked APIs
// ---------------------------------------------------------------------------

const LCX_ROUTER = '0x0000000000b1ae06c96aB73FF4360d7AeAaB56F0';
const ALLOWANCE_HOLDER = '0x0000000000001fF3684f28c67538d4D072C22734';
const NATIVE_EEEE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const NATIVE_ZERO = '0x0000000000000000000000000000000000000000';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const ONE_ETH = '1000000000000000000';

const CONTEXT: ActionContext = {
  walletAddress: '0xabcdef1234567890abcdef1234567890abcdef12',
  chain: 'ethereum',
  walletId: '550e8400-e29b-41d4-a716-446655440000',
};

let lcxQuote: { chainId: number; tokenIn: string; tokenOut: string; amountIn: string } | undefined;

const server = setupServer(
  http.post('https://swap-api.lcx.com/v1/quote', async ({ request }) => {
    lcxQuote = (await request.json()) as typeof lcxQuote;
    const q = lcxQuote!;
    return HttpResponse.json({
      success: true,
      data: {
        quote: {
          quoteId: 'q-1',
          chainId: q.chainId,
          input: { token: q.tokenIn, amount: q.amountIn },
          output: { token: q.tokenOut, amount: '1000', minimumAmount: '995' },
          spender: LCX_ROUTER,
        },
      },
    });
  }),
  http.post('https://swap-api.lcx.com/v1/build', () => {
    const q = lcxQuote!;
    const [tokenIn, tokenOut] = [q.tokenIn as `0x${string}`, q.tokenOut as `0x${string}`];
    const data = encodeFunctionData({
      abi: LCX_ROUTER_ABI,
      functionName: 'swapSplit',
      args: [tokenIn, tokenOut, BigInt(q.amountIn), 995n, CONTEXT.walletAddress as `0x${string}`, BigInt(Math.floor(Date.now() / 1000) + 600),
        [{ amountIn: BigInt(q.amountIn), hops: [{ family: 1, pool: LCX_ROUTER, tokenIn, tokenOut, aux: 0n }] }]],
    });
    return HttpResponse.json({
      success: true,
      data: {
        routerDeployed: true,
        swap: { chainId: q.chainId, to: LCX_ROUTER, data, value: q.tokenIn === NATIVE_ZERO ? q.amountIn : '0' },
        minAmountOut: '995',
        deadline: '1800000000',
      },
    });
  }),
  http.get('https://api.0x.org/swap/allowance-holder/quote', ({ request }) => {
    const url = new URL(request.url);
    const sellToken = url.searchParams.get('sellToken')!;
    const sellAmount = url.searchParams.get('sellAmount')!;
    return HttpResponse.json({
      blockNumber: '1', buyAmount: '1000', buyToken: url.searchParams.get('buyToken'),
      fees: { integratorFee: null, zeroExFee: null, gasFee: null },
      liquidityAvailable: true, minBuyAmount: '995',
      route: { fills: [], tokens: [] },
      sellAmount, sellToken, totalNetworkFee: '0',
      transaction: {
        to: ALLOWANCE_HOLDER, data: '0x2213bc0b0001',
        value: sellToken.toLowerCase() === NATIVE_EEEE.toLowerCase() ? sellAmount : '0',
      },
    });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());

// ---------------------------------------------------------------------------
// DB + settings helpers
// ---------------------------------------------------------------------------

let conn: DatabaseConnection;
let settings: SettingsService;
let engine: DatabasePolicyEngine;
let walletId: string;

beforeEach(async () => {
  conn = createDatabase(':memory:');
  pushSchema(conn.sqlite);
  settings = new SettingsService({ db: conn.db, config: DaemonConfigSchema.parse({}), masterPassword: 'test-master-password' });
  engine = new DatabasePolicyEngine(conn.db, undefined, settings);
  walletId = generateId();
  const now = new Date(Math.floor(Date.now() / 1000) * 1000);
  await conn.db.insert(wallets).values({
    id: walletId, name: 'evm', chain: 'ethereum', environment: 'mainnet',
    publicKey: CONTEXT.walletAddress, status: 'ACTIVE', createdAt: now, updatedAt: now,
  });
});

afterEach(() => {
  conn.sqlite.close();
  lcxQuote = undefined;
});

async function insertPolicy(type: string, rules: unknown): Promise<void> {
  const now = new Date(Math.floor(Date.now() / 1000) * 1000);
  await conn.db.insert(policies).values({
    id: generateId(), walletId, type, rules: JSON.stringify(rules), priority: 1, enabled: true, createdAt: now, updatedAt: now,
  });
}

/** Only the two swap providers under comparison; every other built-in stays off. */
const COMPARED = new Set(['actions.lcx_liberty_swap_enabled', 'actions.zerox_swap_enabled']);
const reader = { get: (k: string) => (k.endsWith('_enabled') && !COMPARED.has(k) ? 'false' : settings.get(k)) };

function setEnabled(enabled: boolean): void {
  settings.set('actions.lcx_liberty_swap_enabled', String(enabled));
  settings.set('actions.zerox_swap_enabled', String(enabled));
}

async function resolveBoth(params: Record<string, unknown>) {
  setEnabled(true);
  settings.set('actions.lcx_liberty_swap_api_key', 'test-key');
  settings.set('actions.zerox_swap_api_key', 'test-key');
  const registry = new ActionProviderRegistry();
  registerBuiltInProviders(registry, reader);
  const lcx = await registry.executeResolve('lcx_liberty_swap/swap', params, CONTEXT) as ContractCallRequest[];
  const zerox = await registry.executeResolve('zerox_swap/swap', params, CONTEXT) as ContractCallRequest[];
  return { lcx, zerox };
}

async function evaluateAll(requests: ContractCallRequest[]) {
  return Promise.all(requests.map(async (r) => {
    const result = await engine.evaluate(walletId, {
      ...buildTransactionParam(r, 'CONTRACT_CALL', 'ethereum'),
      network: 'ethereum-mainnet',
    });
    // Contract addresses differ between providers; compare outcomes only
    return { allowed: result.allowed, tier: result.tier, reason: result.reason?.replace(/0x[0-9a-fA-F]+/g, '<addr>') };
  }));
}

const NATIVE_SELL = { sellToken: NATIVE_EEEE, buyToken: USDC, sellAmount: ONE_ETH, chainId: 1 };
const TOKEN_SELL = { sellToken: USDC, buyToken: WETH, sellAmount: '1000000000', chainId: 1 };
const BIG_LIMIT = { instant_max: '999999999999999999999', notify_max: '999999999999999999999', delay_max: '999999999999999999999', delay_seconds: 60 };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LCX Liberty DEX policy parity with 0x', () => {
  it('is not registered with default settings (opt-in)', () => {
    const registry = new ActionProviderRegistry();
    const { loaded, skipped } = registerBuiltInProviders(registry, reader);
    expect(settings.get('actions.lcx_liberty_swap_enabled')).toBe('false');
    expect(skipped).toContain('lcx_liberty_swap');
    expect(loaded).not.toContain('lcx_liberty_swap');
    expect(registry.getProvider('lcx_liberty_swap')).toBeUndefined();
    expect(settings.hasApiKey('lcx_liberty_swap')).toBe(false);
  });

  it('tags every resolved request with actionProvider=lcx_liberty_swap', async () => {
    const { lcx } = await resolveBoth(TOKEN_SELL);
    expect(lcx).toHaveLength(2);
    for (const req of lcx) expect(req.actionProvider).toBe('lcx_liberty_swap');
  });

  it('CONTRACT_WHITELIST trust follows the enabled toggle exactly as for 0x', async () => {
    await insertPolicy('SPENDING_LIMIT', BIG_LIMIT);
    const { lcx, zerox } = await resolveBoth(TOKEN_SELL);

    const enabledLcx = await evaluateAll(lcx);
    expect(enabledLcx).toEqual(await evaluateAll(zerox));
    expect(enabledLcx.every((r) => r.allowed)).toBe(true);

    setEnabled(false);
    const disabledLcx = await evaluateAll(lcx);
    expect(disabledLcx).toEqual(await evaluateAll(zerox));
    for (const r of disabledLcx) {
      expect(r.allowed).toBe(false);
      expect(r.reason).toContain('no CONTRACT_WHITELIST');
    }
  });

  it('SPENDING_LIMIT sees the native value of a swap exactly as for 0x', async () => {
    await insertPolicy('SPENDING_LIMIT', {
      instant_max: '100000000000000000', // 0.1 ETH
      notify_max: '500000000000000000',  // 0.5 ETH
      delay_max: '2000000000000000000',  // 2 ETH
      delay_seconds: 60,
    });

    const native = await resolveBoth(NATIVE_SELL);
    expect(native.lcx).toHaveLength(1);
    expect(native.lcx[0]!.value).toBe(ONE_ETH);
    const nativeLcx = await evaluateAll(native.lcx);
    expect(nativeLcx).toEqual(await evaluateAll(native.zerox));
    expect(nativeLcx[0]).toMatchObject({ allowed: true, tier: 'DELAY' });

    const token = await resolveBoth(TOKEN_SELL);
    expect(await evaluateAll(token.lcx)).toEqual(await evaluateAll(token.zerox));
  });

  it('METHOD_WHITELIST still applies to the router when the provider is trusted, as for 0x', async () => {
    await insertPolicy('SPENDING_LIMIT', BIG_LIMIT);
    await insertPolicy('METHOD_WHITELIST', {
      methods: [
        { contractAddress: LCX_ROUTER, selectors: ['0xdeadbeef'] },
        { contractAddress: ALLOWANCE_HOLDER, selectors: ['0xdeadbeef'] },
      ],
    });

    const { lcx, zerox } = await resolveBoth(NATIVE_SELL);
    const lcxResults = await evaluateAll(lcx);
    expect(lcxResults).toEqual(await evaluateAll(zerox));
    expect(lcxResults[0]!.allowed).toBe(false);
    expect(lcxResults[0]!.reason).toContain('Method not whitelisted');
  });
});
