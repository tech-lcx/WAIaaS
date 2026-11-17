/**
 * LCX Liberty DEX router calldata verification.
 *
 * Decodes the built swap calldata and checks what the router will actually
 * execute against the request, before anything is signed or approved.
 * These are the same rules the LCX Liberty DEX swap UI applies.
 */
import { decodeFunctionData, type Hex } from 'viem';

const LEGS = { name: 'legs', type: 'tuple[]', components: [
  { name: 'amountIn', type: 'uint256' },
  { name: 'hops', type: 'tuple[]', components: [
    { name: 'family', type: 'uint8' }, { name: 'pool', type: 'address' },
    { name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' },
    { name: 'aux', type: 'uint256' }] }] } as const;
const FEE_SWAP_ARGS = { name: 'a', type: 'tuple', components: [
  { name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' },
  { name: 'totalIn', type: 'uint256' }, { name: 'minAmountOut', type: 'uint256' },
  { name: 'recipient', type: 'address' }, { name: 'deadline', type: 'uint256' },
  { name: 'integrator', type: 'address' }] } as const;
const AMOUNT_OUT = [{ name: 'amountOut', type: 'uint256' }] as const;

/** The five router entrypoints a build may return. Anything else is refused. */
export const LCX_ROUTER_ABI = [
  { name: 'swapSplit', type: 'function', stateMutability: 'payable', inputs: [
    { name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' },
    { name: 'totalIn', type: 'uint256' }, { name: 'minAmountOut', type: 'uint256' },
    { name: 'recipient', type: 'address' }, { name: 'deadline', type: 'uint256' }, LEGS],
    outputs: AMOUNT_OUT },
  { name: 'swapSplitWithFee', type: 'function', stateMutability: 'payable',
    inputs: [FEE_SWAP_ARGS, LEGS], outputs: AMOUNT_OUT },
  { name: 'swapSplitViaPropAMM', type: 'function', stateMutability: 'payable',
    inputs: [FEE_SWAP_ARGS, LEGS, { name: 'venue', type: 'address' }, { name: 'coreNetOut', type: 'uint256' }],
    outputs: AMOUNT_OUT },
  { name: 'swapSplitWithPropAMMSplit', type: 'function', stateMutability: 'payable',
    inputs: [FEE_SWAP_ARGS, { ...LEGS, name: 'splitLegs' }, { ...LEGS, name: 'fullLegs' },
      { name: 's', type: 'tuple', components: [
        { name: 'venue', type: 'address' }, { name: 'venueIn', type: 'uint256' }, { name: 'venueMinOut', type: 'uint256' }] }],
    outputs: AMOUNT_OUT },
  { name: 'makerSwap', type: 'function', stateMutability: 'payable', inputs: [
    { name: 'a', type: 'tuple', components: [
      { name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' },
      { name: 'amountIn', type: 'uint256' }, { name: 'minAmountOut', type: 'uint256' },
      { name: 'recipient', type: 'address' }, { name: 'deadline', type: 'uint256' }] },
    { ...LEGS, name: 'poolLegs' },
    { name: 'm', type: 'tuple', components: [
      { name: 'target', type: 'address' }, { name: 'spender', type: 'address' },
      { name: 'amountIn', type: 'uint256' }, { name: 'minOut', type: 'uint256' }, { name: 'data', type: 'bytes' }] },
    { ...LEGS, name: 'fallbackLegs' }],
    outputs: AMOUNT_OUT },
] as const;

/** Bebop settlement contracts: the only makerSwap target/spender accepted. */
const BEBOP = new Set(['0xbeb0009aca35087ce7ccf11637e24dd1aad3bf2a', '0xbbbbbbb520d69a9775e85b458c58c648259fad5f']);
const ZERO = '0x0000000000000000000000000000000000000000';

export interface ExpectedRouterCall {
  tokenIn: string;       // lowercase, native = zero address
  tokenOut: string;      // lowercase, native = zero address
  amountIn: bigint;
  minAmountOut: bigint;  // quote floor
  recipient: string;
  nowSec: bigint;
}

/** Returns a refusal reason, or null when the calldata matches the request. */
export function checkRouterCalldata(data: string, expected: ExpectedRouterCall): string | null {
  let call;
  try {
    call = decodeFunctionData({ abi: LCX_ROUTER_ABI, data: data as Hex });
  } catch {
    return 'Router calldata is not a known LCX Liberty DEX entrypoint';
  }

  let a: { tokenIn: string; tokenOut: string; totalIn: bigint; minAmountOut: bigint; recipient: string; deadline: bigint };
  if (call.functionName === 'swapSplit') {
    const [tokenIn, tokenOut, totalIn, minAmountOut, recipient, deadline] = call.args;
    a = { tokenIn, tokenOut, totalIn, minAmountOut, recipient, deadline };
  } else if (call.functionName === 'makerSwap') {
    const [args, , m] = call.args;
    a = { ...args, totalIn: args.amountIn };
    // The maker leg is either a Bebop settlement or entirely empty
    const bebop = BEBOP.has(m.target.toLowerCase()) && BEBOP.has(m.spender.toLowerCase());
    const empty = m.amountIn === 0n && m.target === ZERO && m.spender === ZERO && m.data === '0x';
    if ((!bebop && !empty) || m.amountIn > a.totalIn) {
      return 'makerSwap maker leg is not a Bebop settlement within the sold amount';
    }
  } else {
    a = call.args[0];
    // We never request an integrator, so none may take a fee
    if (call.args[0].integrator !== ZERO) return `Calldata integrator ${call.args[0].integrator} is not empty`;
    // A prop-AMM venue needs no allowlist: the router's final minAmountOut check reverts unless the floor is met
    if (call.functionName === 'swapSplitWithPropAMMSplit' && call.args[3].venueIn > a.totalIn) {
      return 'Prop-AMM venue amount exceeds the sold amount';
    }
  }

  if (a.recipient.toLowerCase() !== expected.recipient.toLowerCase()) return `Calldata recipient ${a.recipient} is not the wallet`;
  if (a.totalIn !== expected.amountIn) return `Calldata amount ${a.totalIn} is not the sold amount ${expected.amountIn}`;
  if (a.tokenIn.toLowerCase() !== expected.tokenIn || a.tokenOut.toLowerCase() !== expected.tokenOut) return 'Calldata tokens do not match the request';
  if (a.minAmountOut < expected.minAmountOut) return `Calldata minAmountOut ${a.minAmountOut} is below the quoted floor ${expected.minAmountOut}`;
  if (a.deadline <= expected.nowSec) return 'Calldata deadline has passed';
  return null;
}
