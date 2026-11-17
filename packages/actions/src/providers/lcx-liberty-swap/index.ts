/**
 * LCX Liberty DEX Swap Action Provider.
 *
 * Implements IActionProvider to resolve LCX Liberty DEX swap requests
 * into ContractCallRequest arrays for the sequential pipeline.
 *
 * ERC-20 sells produce [approve, swap] (2 elements, exact-amount approve).
 * Native coin sells produce [swap] (1 element).
 *
 * Every quote and build is checked against the request and the published
 * router, and the router calldata is decoded and checked, before any
 * ContractCallRequest (including the approval) is returned.
 */
import { z } from 'zod';
import { ChainError } from '@waiaas/core';
import type {
  IActionProvider,
  ActionProviderMetadata,
  ActionDefinition,
  ActionContext,
  ContractCallRequest,
  ILogger,
} from '@waiaas/core';
import { LcxLibertyApiClient } from './lcx-liberty-api-client.js';
import { checkRouterCalldata } from './router-calldata.js';
import {
  type LcxLibertySwapConfig,
  LCX_LIBERTY_SWAP_DEFAULTS,
  LCX_NATIVE_TOKEN,
  getLcxLibertyRouterAddress,
} from './config.js';
import { clampSlippageBps, asBps } from '../../common/slippage.js';
import { encodeApproveCalldata } from '../../common/contract-encoding.js';
import { resolveProviderHumanAmount } from '../../common/resolve-human-amount.js';

// 0x-style native placeholder, accepted as an alias for the native coin
const NATIVE_EEEE_ADDRESS = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

// ---------------------------------------------------------------------------
// Input schema for the swap action
// ---------------------------------------------------------------------------

const SwapInputSchema = z.object({
  sellToken: z.string().regex(EVM_ADDRESS, 'sellToken must be an EVM address')
    .describe('Token to sell. Use 0x0000000000000000000000000000000000000000 (or 0xEeee...EEeE) for the native coin.'),
  buyToken: z.string().regex(EVM_ADDRESS, 'buyToken must be an EVM address'),
  sellAmount: z.string().regex(/^\d+$/, 'sellAmount must be an integer string in smallest units').describe('Sell amount in smallest units (wei). Example: "1000000000000000000" = 1 ETH').optional(),
  humanSellAmount: z.string().min(1).optional()
    .describe('Human-readable sell amount (e.g., "1.5" for 1.5 ETH). Requires decimals field. Mutually exclusive with sellAmount.'),
  decimals: z.number().int().min(0).max(24).optional()
    .describe('Token decimals for humanSellAmount conversion. Required when using humanSellAmount.'),
  slippageBps: z.number().int().optional(),
  chainId: z.number().int().optional()
    .describe('EVM chain ID. Must match the network the transaction is sent on. Defaults to 1 (Ethereum).'),
});

function normalizeToken(address: string): string {
  const lower = address.toLowerCase();
  return lower === NATIVE_EEEE_ADDRESS ? LCX_NATIVE_TOKEN : lower;
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function reject(message: string): never {
  throw new ChainError('INVALID_INSTRUCTION', 'ethereum', { message });
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

export class LcxLibertySwapActionProvider implements IActionProvider {
  readonly metadata: ActionProviderMetadata;
  readonly actions: readonly ActionDefinition[];

  private readonly config: LcxLibertySwapConfig;
  private readonly logger?: ILogger;

  constructor(config?: Partial<LcxLibertySwapConfig>, logger?: ILogger) {
    this.config = { ...LCX_LIBERTY_SWAP_DEFAULTS, ...config };
    this.logger = logger;

    this.metadata = {
      name: 'lcx_liberty_swap',
      displayName: 'LCX Liberty DEX',
      description: 'LCX Liberty DEX aggregator for same-chain EVM token swaps',
      version: '1.0.0',
      chains: ['ethereum'],
      mcpExpose: true,
      requiresApiKey: true,
      requiredApis: ['lcx-liberty-dex'],
      requiresSigningKey: false,
    };

    this.actions = [
      {
        name: 'swap',
        description: 'Swap tokens on one EVM chain via LCX Liberty DEX with slippage protection and an exact-amount router approval',
        chain: 'ethereum',
        inputSchema: SwapInputSchema,
        riskLevel: 'medium',
        defaultTier: 'INSTANT',
      },
    ] as const;
  }

  async resolve(
    actionName: string,
    params: Record<string, unknown>,
    context: ActionContext,
  ): Promise<ContractCallRequest[]> {
    if (actionName !== 'swap') reject(`Unknown action: ${actionName}`);

    // humanSellAmount -> sellAmount conversion
    const resolvedParams = { ...params };
    resolveProviderHumanAmount(resolvedParams, 'sellAmount', 'humanSellAmount');

    const input = SwapInputSchema.parse(resolvedParams);
    if (!input.sellAmount) reject('Either sellAmount or humanSellAmount (with decimals) is required');
    const amountIn = BigInt(input.sellAmount);
    if (amountIn === 0n) reject('sellAmount must be greater than zero');

    const tokenIn = normalizeToken(input.sellToken);
    const tokenOut = normalizeToken(input.buyToken);
    if (tokenIn === tokenOut) reject('Cannot swap a token for itself');
    const isNativeSell = tokenIn === LCX_NATIVE_TOKEN;

    // Unsupported chains are refused before any API call
    const chainId = input.chainId ?? 1;
    const router = getLcxLibertyRouterAddress(chainId);

    const slippageBps = clampSlippageBps(
      input.slippageBps ?? 0,
      asBps(this.config.defaultSlippageBps),
      asBps(this.config.maxSlippageBps),
    );

    const apiClient = new LcxLibertyApiClient(this.config, this.logger);

    // 1. Quote
    const { quote } = (await apiClient.getQuote({
      chainId, tokenIn, tokenOut, amountIn: amountIn.toString(), slippageBps,
    })).data;

    if (quote.chainId !== chainId) reject(`Quote chain mismatch: expected ${chainId}, got ${quote.chainId}`);
    if (!sameAddress(quote.spender, router)) reject(`Spender mismatch: expected ${router}, got ${quote.spender}`);
    if (!sameAddress(quote.input.token, tokenIn) || !sameAddress(quote.output.token, tokenOut)) {
      reject('Quote token mismatch');
    }
    if (quote.input.amount !== amountIn.toString()) {
      reject(`Quote amount mismatch: expected ${amountIn}, got ${quote.input.amount}`);
    }

    // 2. Build (recipient is always the wallet itself)
    const build = (await apiClient.buildSwap({
      quoteId: quote.quoteId, recipient: context.walletAddress, slippageBps,
    })).data;

    const swap = build.swap;
    if (!build.routerDeployed || !swap) reject(`LCX Liberty DEX router is not deployed on chain ${chainId}`);
    if (swap.chainId !== chainId) reject(`Build chain mismatch: expected ${chainId}, got ${swap.chainId}`);
    if (!sameAddress(swap.to, router)) reject(`Router mismatch: expected ${router}, got ${swap.to}`);
    if (build.minAmountOut !== quote.output.minimumAmount) {
      reject(`minAmountOut mismatch: quote ${quote.output.minimumAmount}, build ${build.minAmountOut}`);
    }
    const expectedValue = isNativeSell ? amountIn : 0n;
    if (BigInt(swap.value) !== expectedValue) {
      reject(`Swap value mismatch: expected ${expectedValue}, got ${swap.value}`);
    }

    // 3. Decode what the router will execute and check it against the request
    const problem = checkRouterCalldata(swap.data, {
      tokenIn, tokenOut, amountIn,
      minAmountOut: BigInt(quote.output.minimumAmount),
      recipient: context.walletAddress,
      nowSec: BigInt(Math.floor(Date.now() / 1000)),
    });
    if (problem) reject(problem);

    const swapRequest: ContractCallRequest = {
      type: 'CONTRACT_CALL',
      to: swap.to,
      calldata: swap.data,
      value: expectedValue.toString(),
    };
    if (isNativeSell) return [swapRequest];

    // ERC-20 sell: approve exactly amountIn to the router, then swap
    const approveRequest: ContractCallRequest = {
      type: 'CONTRACT_CALL',
      to: input.sellToken,
      calldata: encodeApproveCalldata(router, amountIn),
      value: '0',
    };

    return [approveRequest, swapRequest];
  }
}
