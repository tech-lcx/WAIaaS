/**
 * Zod schemas for LCX Liberty DEX swap API responses.
 * Runtime validation to detect API drift early.
 *
 * Endpoints:
 * - POST /v1/quote -> QuoteResponseSchema
 * - POST /v1/build -> BuildResponseSchema
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Quote Response (POST /v1/quote)
// ---------------------------------------------------------------------------

export const LcxQuoteSchema = z.object({
  quoteId: z.string().min(1),
  chainId: z.number().int(),
  input: z.object({
    token: z.string(),
    amount: z.string(),
  }).passthrough(),
  output: z.object({
    token: z.string(),
    amount: z.string(),
    minimumAmount: z.string().regex(/^\d+$/),
  }).passthrough(),
  spender: z.string(),   // router (ERC-20 approval target)
}).passthrough(); // Allow extra fields from API updates

export type LcxQuote = z.infer<typeof LcxQuoteSchema>;

export const QuoteResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({ quote: LcxQuoteSchema }).passthrough(),
}).passthrough();

export type QuoteResponse = z.infer<typeof QuoteResponseSchema>;

// ---------------------------------------------------------------------------
// Build Response (POST /v1/build)
// ---------------------------------------------------------------------------

export const BuildResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    routerDeployed: z.boolean(),
    swap: z.object({
      chainId: z.number().int(),
      to: z.string(),        // router
      data: z.string(),      // calldata (hex)
      value: z.string().regex(/^\d+$/),  // native value (wei, decimal string)
    }).passthrough().nullable(),
    minAmountOut: z.string(),
  }).passthrough(),
}).passthrough();

export type BuildResponse = z.infer<typeof BuildResponseSchema>;
