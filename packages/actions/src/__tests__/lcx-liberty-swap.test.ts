/**
 * LcxLibertySwapActionProvider unit tests.
 * Uses msw to intercept LCX Liberty DEX quote/build calls (no live network).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { LcxLibertySwapActionProvider } from '../providers/lcx-liberty-swap/index.js';
import {
  LCX_LIBERTY_ROUTER_ADDRESSES,
  LCX_LIBERTY_SWAP_DEFAULTS,
  getLcxLibertyRouterAddress,
} from '../providers/lcx-liberty-swap/config.js';
import { LcxLibertyApiClient } from '../providers/lcx-liberty-swap/lcx-liberty-api-client.js';
import { LCX_ROUTER_ABI } from '../providers/lcx-liberty-swap/router-calldata.js';
import { encodeFunctionData } from 'viem';
import type { ActionContext } from '@waiaas/core';

// ---------------------------------------------------------------------------
// Constants and canned responses
// ---------------------------------------------------------------------------

const API = 'https://swap-api.lcx.com/v1';
const ROUTER = '0x0000000000b1ae06c96aB73FF4360d7AeAaB56F0';
const ROUTER_POLYGON = '0x0000000000654902B6Ed6cC240cc81CB4c4a3dff';
const NATIVE = '0x0000000000000000000000000000000000000000';
const NATIVE_EEEE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const ONE_ETH = '1000000000000000000';

const CONTEXT: ActionContext = {
  walletAddress: '0x1234567890123456789012345678901234567890',
  chain: 'ethereum',
  walletId: '00000000-0000-0000-0000-000000000001',
};

interface QuoteBody { chainId: number; tokenIn: string; tokenOut: string; amountIn: string; slippageBps: number }

function makeQuote(body: QuoteBody, overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    data: {
      quote: {
        quoteId: 'q-123',
        chainId: body.chainId,
        input: { token: body.tokenIn, amount: body.amountIn, decimals: 18 },
        output: { token: body.tokenOut, amount: '3000000000', minimumAmount: '2985000000', decimals: 6 },
        priceImpactPct: 0.01,
        spender: LCX_LIBERTY_ROUTER_ADDRESSES.get(body.chainId) ?? ROUTER,
        nativeIn: body.tokenIn === NATIVE,
        nativeOut: false,
        expiresAt: 1_800_000_000,
        stale: false,
        ...overrides,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Router calldata encoders (what a real build returns in swap.data)
// ---------------------------------------------------------------------------

type Addr = `0x${string}`;
const BEBOP = '0xbbbbbbb520d69a9775e85b458c58c648259fad5f' as Addr;
const DEAD = '0x000000000000000000000000000000000000dEaD' as Addr;
const FLOOR = 2985000000n;
const future = () => BigInt(Math.floor(Date.now() / 1000) + 600);

interface CallFields { tokenIn: Addr; tokenOut: Addr; totalIn: bigint; minAmountOut: bigint; recipient: Addr; deadline: bigint }

function fields(b: QuoteBody, o: Partial<CallFields> = {}): CallFields {
  return {
    tokenIn: b.tokenIn as Addr, tokenOut: b.tokenOut as Addr, totalIn: BigInt(b.amountIn),
    minAmountOut: FLOOR, recipient: CONTEXT.walletAddress as Addr, deadline: future(), ...o,
  };
}
const legs = (f: CallFields) => [{ amountIn: f.totalIn, hops: [{ family: 1, pool: DEAD, tokenIn: f.tokenIn, tokenOut: f.tokenOut, aux: 0n }] }];
const feeArgs = (f: CallFields, integrator = NATIVE as Addr) => ({ ...f, integrator });

function swapSplitData(b: QuoteBody, o: Partial<CallFields> = {}): string {
  const f = fields(b, o);
  return encodeFunctionData({ abi: LCX_ROUTER_ABI, functionName: 'swapSplit', args: [f.tokenIn, f.tokenOut, f.totalIn, f.minAmountOut, f.recipient, f.deadline, legs(f)] });
}
function wrapperData(b: QuoteBody, fn: 'swapSplitWithFee' | 'swapSplitViaPropAMM' | 'swapSplitWithPropAMMSplit', o: Partial<CallFields> = {}, integrator?: Addr, venueIn = 1n): string {
  const f = fields(b, o);
  const a = feeArgs(f, integrator);
  if (fn === 'swapSplitWithFee') return encodeFunctionData({ abi: LCX_ROUTER_ABI, functionName: fn, args: [a, legs(f)] });
  if (fn === 'swapSplitViaPropAMM') return encodeFunctionData({ abi: LCX_ROUTER_ABI, functionName: fn, args: [a, legs(f), DEAD, 1n] });
  return encodeFunctionData({ abi: LCX_ROUTER_ABI, functionName: fn, args: [a, legs(f), legs(f), { venue: DEAD, venueIn, venueMinOut: 1n }] });
}
function makerSwapData(b: QuoteBody, m: Partial<{ target: Addr; spender: Addr; amountIn: bigint; data: Addr }> = {}): string {
  const f = fields(b);
  const a = { tokenIn: f.tokenIn, tokenOut: f.tokenOut, amountIn: f.totalIn, minAmountOut: f.minAmountOut, recipient: f.recipient, deadline: f.deadline };
  const maker = { target: BEBOP, spender: BEBOP, amountIn: f.totalIn / 2n, minOut: 1n, data: '0x' as Addr, ...m };
  return encodeFunctionData({ abi: LCX_ROUTER_ABI, functionName: 'makerSwap', args: [a, legs(f), maker, legs(f)] });
}

function makeBuild(b: QuoteBody, value = b.tokenIn === NATIVE ? b.amountIn : '0', overrides: Record<string, unknown> = {}, swapOverrides: Record<string, unknown> = {}) {
  return {
    success: true,
    data: {
      routerDeployed: true,
      swap: { chainId: b.chainId, to: LCX_LIBERTY_ROUTER_ADDRESSES.get(b.chainId) ?? ROUTER, data: swapSplitData(b), value, ...swapOverrides },
      minAmountOut: '2985000000',
      deadline: '1800000120',
      simulation: { status: 'skipped', why: 'awaiting_allowance' },
      ...overrides,
    },
  };
}

let lastQuoteBody: QuoteBody | undefined;
let lastBuildBody: Record<string, unknown> | undefined;
let lastAuthHeader: string | null = null;

/** Default handlers: echo the request into a consistent quote, build with matching value. */
function defaultHandlers(opts: {
  quote?: (b: QuoteBody) => Record<string, unknown>;
  build?: (b: QuoteBody) => Record<string, unknown>;
} = {}) {
  return [
    http.post(`${API}/quote`, async ({ request }) => {
      lastAuthHeader = request.headers.get('authorization');
      lastQuoteBody = (await request.json()) as QuoteBody;
      return HttpResponse.json(opts.quote ? opts.quote(lastQuoteBody) : makeQuote(lastQuoteBody));
    }),
    http.post(`${API}/build`, async ({ request }) => {
      lastBuildBody = (await request.json()) as Record<string, unknown>;
      const q = lastQuoteBody!;
      return HttpResponse.json(
        opts.build ? opts.build(q) : makeBuild(q),
      );
    }),
  ];
}

const server = setupServer(...defaultHandlers());

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  lastQuoteBody = undefined;
  lastBuildBody = undefined;
  lastAuthHeader = null;
});
afterAll(() => server.close());

function provider(config: Record<string, unknown> = {}) {
  return new LcxLibertySwapActionProvider({ enabled: true, apiKey: 'test-key', ...config });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LcxLibertySwapActionProvider', () => {
  describe('metadata', () => {
    it('declares an opt-in, API-key-gated, MCP-exposed EVM swap provider', () => {
      const p = new LcxLibertySwapActionProvider();
      expect(p.metadata.name).toBe('lcx_liberty_swap');
      expect(p.metadata.displayName).toBe('LCX Liberty DEX');
      expect(p.metadata.chains).toEqual(['ethereum']);
      expect(p.metadata.requiresApiKey).toBe(true);
      expect(p.metadata.mcpExpose).toBe(true);
      expect(LCX_LIBERTY_SWAP_DEFAULTS.enabled).toBe(false);
      expect(LCX_LIBERTY_SWAP_DEFAULTS.apiKey).toBe('');
    });

    it('has one swap action with the same tier and risk as the 0x swap', () => {
      const p = new LcxLibertySwapActionProvider();
      expect(p.actions).toHaveLength(1);
      expect(p.actions[0]!.name).toBe('swap');
      expect(p.actions[0]!.defaultTier).toBe('INSTANT');
      expect(p.actions[0]!.riskLevel).toBe('medium');
    });
  });

  describe('ERC-20 sell', () => {
    it('returns [approve(exact amount), swap] and sends the expected quote/build bodies', async () => {
      const result = await provider().resolve('swap', {
        sellToken: USDC, buyToken: WETH, sellAmount: '1000000000',
      }, CONTEXT);

      expect(lastAuthHeader).toBe('Bearer test-key');
      expect(lastQuoteBody).toEqual({
        chainId: 1, tokenIn: USDC.toLowerCase(), tokenOut: WETH.toLowerCase(), amountIn: '1000000000', slippageBps: 50,
      });
      expect(lastBuildBody).toEqual({ quoteId: 'q-123', recipient: CONTEXT.walletAddress, slippageBps: 50 });

      expect(result).toHaveLength(2);
      const [approve, swap] = result;
      expect(approve!.type).toBe('CONTRACT_CALL');
      expect(approve!.to).toBe(USDC);
      expect(approve!.value).toBe('0');
      // approve(router, 1000000000) -- exact amount, never unlimited
      expect(approve!.calldata).toBe(
        '0x095ea7b3'
        + ROUTER.slice(2).toLowerCase().padStart(64, '0')
        + (1000000000n).toString(16).padStart(64, '0'),
      );
      expect(swap!.to).toBe(ROUTER);
      expect(swap!.calldata?.slice(0, 10)).toBe('0xfc54261d'); // swapSplit
      expect(swap!.value).toBe('0');
    });

    it('approves the Polygon router on chain 137', async () => {
      const result = await provider().resolve('swap', {
        sellToken: USDC, buyToken: WETH, sellAmount: '5', chainId: 137,
      }, CONTEXT);
      expect(lastQuoteBody!.chainId).toBe(137);
      expect(result[0]!.calldata).toContain(ROUTER_POLYGON.slice(2).toLowerCase());
      expect(result[1]!.to).toBe(ROUTER_POLYGON);
    });
  });

  describe('native coin sell', () => {
    it('returns [swap] with value equal to sellAmount', async () => {
      const result = await provider().resolve('swap', {
        sellToken: NATIVE, buyToken: USDC, sellAmount: ONE_ETH, chainId: 8453,
      }, CONTEXT);
      expect(result).toHaveLength(1);
      expect(result[0]!.value).toBe(ONE_ETH);
      expect(result[0]!.to).toBe(ROUTER);
    });

    it('maps the 0xEeee placeholder to the zero address', async () => {
      const result = await provider().resolve('swap', {
        sellToken: NATIVE_EEEE, buyToken: USDC, sellAmount: ONE_ETH,
      }, CONTEXT);
      expect(lastQuoteBody!.tokenIn).toBe(NATIVE);
      expect(result).toHaveLength(1);
    });
  });

  describe('amount and slippage', () => {
    it('converts humanSellAmount with decimals', async () => {
      await provider().resolve('swap', {
        sellToken: USDC, buyToken: WETH, humanSellAmount: '100', decimals: 6,
      }, CONTEXT);
      expect(lastQuoteBody!.amountIn).toBe('100000000');
    });

    it('clamps slippage to the configured maximum', async () => {
      await provider().resolve('swap', {
        sellToken: USDC, buyToken: WETH, sellAmount: '1', slippageBps: 5000,
      }, CONTEXT);
      expect(lastQuoteBody!.slippageBps).toBe(500);
      expect(lastBuildBody!.slippageBps).toBe(500);
    });

    it('uses configured default slippage', async () => {
      await provider({ defaultSlippageBps: 30 }).resolve('swap', {
        sellToken: USDC, buyToken: WETH, sellAmount: '1',
      }, CONTEXT);
      expect(lastQuoteBody!.slippageBps).toBe(30);
    });
  });

  describe('input validation (no API call)', () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['same token', { sellToken: USDC, buyToken: USDC.toLowerCase(), sellAmount: '1' }, 'itself'],
      ['native alias vs zero address', { sellToken: NATIVE_EEEE, buyToken: NATIVE, sellAmount: '1' }, 'itself'],
      ['zero amount', { sellToken: USDC, buyToken: WETH, sellAmount: '0' }, 'greater than zero'],
      ['missing amount', { sellToken: USDC, buyToken: WETH }, 'sellAmount or humanSellAmount'],
      ['unsupported chain', { sellToken: USDC, buyToken: WETH, sellAmount: '1', chainId: 56 }, 'Unsupported chain ID 56'],
    ];
    for (const [label, params, message] of cases) {
      it(`rejects ${label}`, async () => {
        await expect(provider().resolve('swap', params, CONTEXT)).rejects.toThrow(message);
        expect(lastQuoteBody).toBeUndefined();
      });
    }

    it('rejects a non-address token', async () => {
      await expect(provider().resolve('swap', { sellToken: 'USDC', buyToken: WETH, sellAmount: '1' }, CONTEXT))
        .rejects.toThrow();
      expect(lastQuoteBody).toBeUndefined();
    });

    it('rejects unknown action names', async () => {
      await expect(provider().resolve('bridge', {}, CONTEXT)).rejects.toThrow('Unknown action: bridge');
    });
  });

  describe('quote validation (no build call)', () => {
    const cases: Array<[string, (b: QuoteBody) => Record<string, unknown>, string]> = [
      ['spender mismatch', (b) => makeQuote(b, { spender: '0x000000000000000000000000000000000000dEaD' }), 'Spender mismatch'],
      ['chain mismatch', (b) => makeQuote(b, { chainId: 10 }), 'Quote chain mismatch'],
      ['input token mismatch', (b) => makeQuote(b, { input: { token: WETH, amount: b.amountIn } }), 'Quote token mismatch'],
      ['output token mismatch', (b) => makeQuote(b, { output: { token: USDC, amount: '1', minimumAmount: '1' } }), 'Quote token mismatch'],
      ['amount mismatch', (b) => makeQuote(b, { input: { token: b.tokenIn, amount: '999' } }), 'Quote amount mismatch'],
    ];
    for (const [label, quote, message] of cases) {
      it(`rejects ${label}`, async () => {
        server.use(...defaultHandlers({ quote }));
        await expect(provider().resolve('swap', { sellToken: USDC, buyToken: WETH, sellAmount: '1000' }, CONTEXT))
          .rejects.toThrow(message);
        expect(lastBuildBody).toBeUndefined();
      });
    }
  });

  describe('build validation', () => {
    const cases: Array<[string, string, (b: QuoteBody) => Record<string, unknown>, string]> = [
      ['router not deployed', USDC, (b) => makeBuild(b, '0', { routerDeployed: false }), 'not deployed'],
      ['missing swap', USDC, (b) => makeBuild(b, '0', { swap: null }), 'not deployed'],
      ['chain mismatch', USDC, (b) => makeBuild(b, '0', {}, { chainId: 10 }), 'Build chain mismatch'],
      ['router mismatch', USDC, (b) => makeBuild(b, '0', {}, { to: '0x000000000000000000000000000000000000dEaD' }), 'Router mismatch'],
      ['minAmountOut mismatch', USDC, (b) => makeBuild(b, '0', { minAmountOut: '1' }), 'minAmountOut mismatch'],
      ['value on a token sell', USDC, (b) => makeBuild(b, '1'), 'Swap value mismatch'],
      ['value below a native sell', NATIVE, (b) => makeBuild(b, '0'), 'Swap value mismatch'],
      ['value above a native sell', NATIVE, (b) => makeBuild(b, `${b.amountIn}0`), 'Swap value mismatch'],
      ['non-decimal value', USDC, (b) => makeBuild(b, '0x0'), 'regex'],
    ];
    for (const [label, sellToken, build, message] of cases) {
      it(`rejects ${label}`, async () => {
        server.use(...defaultHandlers({ build }));
        await expect(provider().resolve('swap', { sellToken, buyToken: WETH, sellAmount: '1000' }, CONTEXT))
          .rejects.toThrow(message);
      });
    }

    it('accepts router addresses in any letter case', async () => {
      server.use(...defaultHandlers({
        quote: (b) => makeQuote(b, { spender: ROUTER.toLowerCase() }),
        build: (b) => makeBuild(b, '0', {}, { to: ROUTER.toUpperCase().replace('0X', '0x') }),
      }));
      const result = await provider().resolve('swap', { sellToken: USDC, buyToken: WETH, sellAmount: '1' }, CONTEXT);
      expect(result).toHaveLength(2);
    });
  });

  describe('router calldata verification', () => {
    const withData = (data: (b: QuoteBody) => string) => (b: QuoteBody) => makeBuild(b, undefined, {}, { data: data(b) });

    const accepted: Array<[string, (b: QuoteBody) => string]> = [
      ['swapSplit', (b) => swapSplitData(b)],
      ['swapSplitWithFee', (b) => wrapperData(b, 'swapSplitWithFee')],
      ['swapSplitViaPropAMM', (b) => wrapperData(b, 'swapSplitViaPropAMM')],
      ['swapSplitWithPropAMMSplit', (b) => wrapperData(b, 'swapSplitWithPropAMMSplit')],
      ['makerSwap with a Bebop maker leg', (b) => makerSwapData(b)],
      ['makerSwap with an empty maker leg', (b) => makerSwapData(b, { target: NATIVE as Addr, spender: NATIVE as Addr, amountIn: 0n })],
      ['a floor above the quote', (b) => swapSplitData(b, { minAmountOut: FLOOR + 1n })],
      ['a prop-AMM split whose venue takes the whole amount', (b) => wrapperData(b, 'swapSplitWithPropAMMSplit', {}, undefined, BigInt(b.amountIn))],
    ];
    for (const [label, data] of accepted) {
      it(`accepts ${label}`, async () => {
        server.use(...defaultHandlers({ build: withData(data) }));
        const result = await provider().resolve('swap', { sellToken: USDC, buyToken: WETH, sellAmount: '1000' }, CONTEXT);
        expect(result).toHaveLength(2);
        expect(result[1]!.calldata).toBe(data(lastQuoteBody!));
      });
    }

    const refused: Array<[string, string, (b: QuoteBody) => Record<string, unknown>, string]> = [
      ['wrong recipient', USDC, withData((b) => swapSplitData(b, { recipient: DEAD })), 'is not the wallet'],
      ['lower floor', USDC, withData((b) => swapSplitData(b, { minAmountOut: FLOOR - 1n })), 'below the quoted floor'],
      ['wrong totalIn', USDC, withData((b) => swapSplitData(b, { totalIn: BigInt(b.amountIn) + 1n })), 'is not the sold amount'],
      ['swapped tokens', USDC, withData((b) => swapSplitData(b, { tokenIn: b.tokenOut as Addr, tokenOut: b.tokenIn as Addr })), 'tokens do not match'],
      ['unknown selector', USDC, withData(() => `0xdeadbeef${'00'.repeat(32)}`), 'not a known LCX Liberty DEX entrypoint'],
      ['wrong value', NATIVE, (b) => makeBuild(b, '1'), 'Swap value mismatch'],
      ['expired deadline', USDC, withData((b) => swapSplitData(b, { deadline: BigInt(Math.floor(Date.now() / 1000) - 1) })), 'deadline has passed'],
      ['makerSwap with a non-Bebop target', USDC, withData((b) => makerSwapData(b, { target: DEAD })), 'not a Bebop settlement'],
      ['makerSwap with a non-Bebop spender', USDC, withData((b) => makerSwapData(b, { spender: DEAD })), 'not a Bebop settlement'],
      ['makerSwap selling more than totalIn', USDC, withData((b) => makerSwapData(b, { amountIn: BigInt(b.amountIn) + 1n })), 'not a Bebop settlement'],
      ['makerSwap with a zero amount but a non-Bebop target', USDC, withData((b) => makerSwapData(b, { target: DEAD, spender: DEAD, amountIn: 0n })), 'not a Bebop settlement'],
      ['makerSwap with an empty leg that still carries data', USDC, withData((b) => makerSwapData(b, { target: NATIVE as Addr, spender: NATIVE as Addr, amountIn: 0n, data: '0x01' })), 'not a Bebop settlement'],
      ['swapSplitWithFee with an integrator', USDC, withData((b) => wrapperData(b, 'swapSplitWithFee', {}, DEAD)), 'integrator'],
      ['swapSplitViaPropAMM with an integrator', USDC, withData((b) => wrapperData(b, 'swapSplitViaPropAMM', {}, DEAD)), 'integrator'],
      ['swapSplitWithPropAMMSplit with an integrator', USDC, withData((b) => wrapperData(b, 'swapSplitWithPropAMMSplit', {}, DEAD)), 'integrator'],
      ['a prop-AMM venueIn above totalIn', USDC, withData((b) => wrapperData(b, 'swapSplitWithPropAMMSplit', {}, undefined, BigInt(b.amountIn) + 1n)), 'venue amount exceeds'],
      ['wrapper with a wrong recipient', USDC, withData((b) => wrapperData(b, 'swapSplitWithPropAMMSplit', { recipient: DEAD })), 'is not the wallet'],
    ];
    for (const [label, sellToken, build, message] of refused) {
      it(`refuses ${label}`, async () => {
        server.use(...defaultHandlers({ build }));
        await expect(provider().resolve('swap', { sellToken, buyToken: WETH, sellAmount: '1000' }, CONTEXT))
          .rejects.toThrow(message);
      });
    }
  });

  describe('API errors', () => {
    it('surfaces 401 API_KEY_REQUIRED as ACTION_API_ERROR', async () => {
      server.use(http.post(`${API}/quote`, () => HttpResponse.json(
        { success: false, code: 'API_KEY_REQUIRED', error: 'API_KEY_REQUIRED', message: 'This API requires a key.' },
        { status: 401 },
      )));
      await expect(provider({ apiKey: '' }).resolve('swap', { sellToken: USDC, buyToken: WETH, sellAmount: '1' }, CONTEXT))
        .rejects.toMatchObject({ code: 'ACTION_API_ERROR' });
    });

    it('surfaces 429 as ACTION_RATE_LIMITED', async () => {
      server.use(http.post(`${API}/quote`, () => HttpResponse.json(
        { success: false, code: 'RATE_LIMITED', error: 'RATE_LIMITED', message: 'slow down' },
        { status: 429 },
      )));
      await expect(provider().resolve('swap', { sellToken: USDC, buyToken: WETH, sellAmount: '1' }, CONTEXT))
        .rejects.toMatchObject({ code: 'ACTION_RATE_LIMITED' });
    });

    it('surfaces a build error (e.g. 410 QUOTE_EXPIRED) and returns nothing', async () => {
      server.use(http.post(`${API}/build`, () => HttpResponse.json(
        { success: false, code: 'QUOTE_EXPIRED', error: 'QUOTE_EXPIRED', message: 'expired' },
        { status: 410 },
      )));
      await expect(provider().resolve('swap', { sellToken: USDC, buyToken: WETH, sellAmount: '1' }, CONTEXT))
        .rejects.toMatchObject({ code: 'ACTION_API_ERROR' });
    });

    it('rejects a response that does not match the schema', async () => {
      server.use(http.post(`${API}/quote`, () => HttpResponse.json({ success: false })));
      await expect(provider().resolve('swap', { sellToken: USDC, buyToken: WETH, sellAmount: '1' }, CONTEXT))
        .rejects.toThrow();
    });
  });
});

describe('LCX Liberty DEX config', () => {
  it('maps each supported WAIaaS EVM mainnet to its published router', () => {
    expect([...LCX_LIBERTY_ROUTER_ADDRESSES.keys()].sort((a, b) => a - b)).toEqual([1, 10, 137, 999, 8453, 42161]);
    for (const id of [1, 10, 8453, 42161]) expect(getLcxLibertyRouterAddress(id)).toBe(ROUTER);
    for (const id of [137, 999]) expect(getLcxLibertyRouterAddress(id)).toBe(ROUTER_POLYGON);
  });

  it('throws for an unsupported chain', () => {
    expect(() => getLcxLibertyRouterAddress(56)).toThrow('Unsupported chain ID 56');
  });
});

describe('LcxLibertyApiClient', () => {
  it('omits the Authorization header when no key is configured', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const client = new LcxLibertyApiClient({ ...LCX_LIBERTY_SWAP_DEFAULTS });
    const body = { chainId: 1, tokenIn: USDC, tokenOut: WETH, amountIn: '1', slippageBps: 50 };
    await client.getQuote(body);
    const headers = fetchSpy.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
    expect(lastAuthHeader).toBeNull();
    fetchSpy.mockRestore();
  });
});

describe('registerBuiltInProviders gate', () => {
  it('skips lcx_liberty_swap unless actions.lcx_liberty_swap_enabled is true', async () => {
    const { registerBuiltInProviders } = await import('../index.js');
    const register = vi.fn();
    const { skipped, loaded } = registerBuiltInProviders({ register }, { get: () => '' });
    expect(skipped).toContain('lcx_liberty_swap');
    expect(loaded).not.toContain('lcx_liberty_swap');
  });

  it('loads lcx_liberty_swap with the key and slippage from settings when enabled', async () => {
    const { registerBuiltInProviders } = await import('../index.js');
    const registered: LcxLibertySwapActionProvider[] = [];
    const settings: Record<string, string> = {
      'actions.lcx_liberty_swap_enabled': 'true',
      'actions.lcx_liberty_swap_api_key': 'settings-key',
      'actions.lcx_liberty_swap_default_slippage_bps': '40',
      'actions.lcx_liberty_swap_max_slippage_bps': '300',
      'actions.lcx_liberty_swap_request_timeout_ms': '5000',
    };
    const { loaded } = registerBuiltInProviders(
      { register: (p) => { if (p.metadata.name === 'lcx_liberty_swap') registered.push(p as LcxLibertySwapActionProvider); } },
      { get: (k) => settings[k] ?? '' },
    );
    expect(loaded).toContain('lcx_liberty_swap');
    expect(registered).toHaveLength(1);

    await registered[0]!.resolve('swap', { sellToken: USDC, buyToken: WETH, sellAmount: '1' }, CONTEXT);
    expect(lastAuthHeader).toBe('Bearer settings-key');
    expect(lastQuoteBody!.slippageBps).toBe(40);
  });
});
