/**
 * LCX Liberty DEX swap configuration type, defaults, and router address mapping.
 *
 * Uses the LCX Liberty DEX swap API (quote -> build) with an exact-amount
 * ERC-20 approval to the published router.
 * See: https://dex.lcx.com/docs
 */

export interface LcxLibertySwapConfig {
  enabled: boolean;
  apiBaseUrl: string;     // 'https://swap-api.lcx.com/v1'
  apiKey: string;         // Authorization: Bearer <key>
  defaultSlippageBps: number;  // 50 (0.5%)
  maxSlippageBps: number;      // 500 (5%)
  requestTimeoutMs: number;    // 10_000
}

export const LCX_LIBERTY_SWAP_DEFAULTS: LcxLibertySwapConfig = {
  enabled: false,
  apiBaseUrl: 'https://swap-api.lcx.com/v1',
  apiKey: '',
  defaultSlippageBps: 50,
  maxSlippageBps: 500,
  requestTimeoutMs: 10_000,
};

/** Native coin placeholder used by the LCX Liberty DEX API. */
export const LCX_NATIVE_TOKEN = '0x0000000000000000000000000000000000000000';

// ---------------------------------------------------------------------------
// Router addresses (published by LCX Liberty DEX)
// ---------------------------------------------------------------------------

const ROUTER_L1_L2 = '0x0000000000b1ae06c96aB73FF4360d7AeAaB56F0';
const ROUTER_OTHER = '0x0000000000654902B6Ed6cC240cc81CB4c4a3dff';

/**
 * Router (swap target and ERC-20 spender) per chain ID.
 * Only EVM mainnets that are both WAIaaS networks and LCX Liberty DEX chains.
 */
export const LCX_LIBERTY_ROUTER_ADDRESSES: ReadonlyMap<number, string> = new Map([
  [1, ROUTER_L1_L2],       // Ethereum
  [10, ROUTER_L1_L2],      // Optimism
  [8453, ROUTER_L1_L2],    // Base
  [42161, ROUTER_L1_L2],   // Arbitrum
  [137, ROUTER_OTHER],     // Polygon
  [999, ROUTER_OTHER],     // HyperEVM
]);

/**
 * Get the LCX Liberty DEX router address for a chain ID.
 * @throws Error if the chain ID is not supported.
 */
export function getLcxLibertyRouterAddress(chainId: number): string {
  const address = LCX_LIBERTY_ROUTER_ADDRESSES.get(chainId);
  if (!address) {
    throw new Error(
      `Unsupported chain ID ${chainId} for LCX Liberty DEX. Supported: ${[...LCX_LIBERTY_ROUTER_ADDRESSES.keys()].join(', ')}`,
    );
  }
  return address;
}
