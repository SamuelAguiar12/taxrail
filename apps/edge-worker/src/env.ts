/**
 * Cloudflare Worker runtime bindings and configuration environment.
 */
export interface Env {
  /** Optional Cloudflare KV namespace for storing pending/unlocked tax plans. */
  TAXRAIL_PLANS?: KVNamespace;
  /** Treasury / Safe address receiving x402 USDC payments on Base. */
  PAY_TO_ADDRESS?: string;
  /** CAIP-2 network identifier for x402 payments (defaults to Base mainnet eip155:8453). */
  X402_NETWORK?: string;
  /** ERC-20 token contract address for x402 payments (defaults to Base USDC). */
  X402_ASSET?: string;
  /** x402 facilitator base URL (defaults to https://x402.org/facilitator). */
  FACILITATOR_URL?: string;
  /** Public base URL advertised in Agent Card, llms.txt, OpenAPI, and x402 resource metadata. */
  PUBLIC_BASE_URL?: string;
  /** Optional non-production bypass token for integration tests (`X-PAYMENT: dev-bypass:<token>`). */
  X402_DEV_BYPASS_TOKEN?: string;
  /** Optional default TaxRail treasury override for swap fee splits. */
  TAXRAIL_TREASURY_ADDRESS?: string;
  /** Alchemy API key (stored as Cloudflare Secret) for live wallet lot scanning & prices. */
  ALCHEMY_API_KEY?: string;
  /** 0x Swap API v2 key (stored as Cloudflare Secret) for live swap quotes & calldata. */
  ZEROX_API_KEY?: string;
}

export const DEFAULT_PAY_TO_ADDRESS = "0x0202e70990d90325A1Dca322C91471Be774E4B6f";
export const DEFAULT_X402_NETWORK = "eip155:8453";
export const DEFAULT_X402_ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const DEFAULT_FACILITATOR_URL = "https://facilitator.payai.network";
export const DEFAULT_PUBLIC_BASE_URL = "https://api.taxrail.online";

/**
 * Resolves the effective public base URL from environment or incoming request URL.
 */
export function resolvePublicBaseUrl(env: Env, requestUrl?: string): string {
  if (env.PUBLIC_BASE_URL) {
    return env.PUBLIC_BASE_URL.replace(/\/$/, "");
  }
  if (requestUrl) {
    try {
      return new URL(requestUrl).origin;
    } catch {
      // Fall back to default public URL below
    }
  }
  return DEFAULT_PUBLIC_BASE_URL;
}
