/**
 * LCX Liberty DEX swap REST API client.
 * Wraps POST /v1/quote and POST /v1/build.
 *
 * Auth is via `Authorization: Bearer <key>` (required on every call).
 */
import type { ILogger } from '@waiaas/core';
import { ActionApiClient } from '../../common/action-api-client.js';
import { QuoteResponseSchema, BuildResponseSchema } from './schemas.js';
import type { QuoteResponse, BuildResponse } from './schemas.js';
import type { LcxLibertySwapConfig } from './config.js';

export class LcxLibertyApiClient extends ActionApiClient {
  constructor(config: LcxLibertySwapConfig, logger?: ILogger) {
    const headers: Record<string, string> = {};
    if (config.apiKey) {
      headers['Authorization'] = `Bearer ${config.apiKey}`;
    }
    super(config.apiBaseUrl, config.requestTimeoutMs, headers, logger);
  }

  async getQuote(params: {
    chainId: number;
    tokenIn: string;
    tokenOut: string;
    amountIn: string;
    slippageBps: number;
  }): Promise<QuoteResponse> {
    return this.post('quote', params, QuoteResponseSchema);
  }

  async buildSwap(params: {
    quoteId: string;
    recipient: string;
    slippageBps: number;
  }): Promise<BuildResponse> {
    return this.post('build', params, BuildResponseSchema);
  }
}
