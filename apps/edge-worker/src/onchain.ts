import type { SupportedChain, TaxLot } from "@taxrail/shared";

type EvmChain = "base" | "ethereum" | "arbitrum";

const ALCHEMY_RPC_HOSTS: Record<EvmChain, string> = {
  base: "https://base-mainnet.g.alchemy.com/v2",
  ethereum: "https://eth-mainnet.g.alchemy.com/v2",
  arbitrum: "https://arb-mainnet.g.alchemy.com/v2",
};

const CHAIN_IDS: Record<EvmChain, number> = {
  ethereum: 1,
  arbitrum: 42161,
  base: 8453,
};

const ZEROX_TOKEN_ADDRESSES: Record<
  EvmChain,
  Record<string, { address: string; decimals: number }>
> = {
  base: {
    ETH: { address: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", decimals: 18 },
    WETH: { address: "0x4200000000000000000000000000000000000006", decimals: 18 },
    USDC: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
    WBTC: { address: "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c", decimals: 8 },
    CBBTC: { address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", decimals: 8 },
  },
  ethereum: {
    ETH: { address: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", decimals: 18 },
    WETH: { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", decimals: 18 },
    USDC: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
    WBTC: { address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", decimals: 8 },
    CBBTC: { address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", decimals: 8 },
  },
  arbitrum: {
    ETH: { address: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", decimals: 18 },
    WETH: { address: "0x82aF49447d8a07e3bd95BD0d56f35241523fBab1", decimals: 18 },
    USDC: { address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6 },
    WBTC: { address: "0x2f2a2543B76A4166549F7aAb2E75BeF0aEFC5B0f", decimals: 8 },
    CBBTC: { address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", decimals: 8 },
  },
};

function normalizeSymbol(asset: string): string {
  const upper = asset.trim().toUpperCase();
  if (upper === "WETH") return "ETH";
  return upper;
}

function isEvmChain(chain: SupportedChain): chain is EvmChain {
  return chain === "base" || chain === "ethereum" || chain === "arbitrum";
}

function decimalToAtomicString(amountDecimal: string, decimals: number): string {
  const [intPartRaw, fracPartRaw = ""] = amountDecimal.trim().split(".");
  const intPart = intPartRaw.replace(/^0+/, "") || "0";
  const paddedFrac = (fracPartRaw + "0".repeat(decimals)).slice(0, decimals);
  const combined = `${intPart}${paddedFrac}`.replace(/^0+/, "") || "0";
  return combined;
}

/**
 * Fetches live USD spot price via Alchemy Prices API with Coinbase fallback.
 */
export async function fetchSpotPriceUsd(
  symbol: string,
  alchemyApiKey?: string
): Promise<{ priceUsd: number; source: "alchemy" | "coinbase" }> {
  const cleanSymbol = normalizeSymbol(symbol);

  if (alchemyApiKey) {
    try {
      const url = `https://api.g.alchemy.com/prices/v1/${encodeURIComponent(
        alchemyApiKey
      )}/tokens/by-symbol?symbols=${encodeURIComponent(cleanSymbol)}`;
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
      });
      if (res.ok) {
        const json = (await res.json()) as {
          data?: Array<{
            symbol?: string;
            prices?: Array<{ currency?: string; value?: string }>;
          }>;
        };
        const usdEntry = json.data?.[0]?.prices?.find(
          (p) => p.currency?.toUpperCase() === "USD" && p.value
        );
        const parsed = usdEntry?.value ? Number(usdEntry.value) : NaN;
        if (Number.isFinite(parsed) && parsed > 0) {
          return { priceUsd: parsed, source: "alchemy" };
        }
      }
    } catch {
      // Fall through to Coinbase spot price
    }
  }

  const cbRes = await fetch(
    `https://api.coinbase.com/v2/prices/${encodeURIComponent(cleanSymbol)}-USD/spot`,
    { headers: { Accept: "application/json" } }
  );
  if (cbRes.ok) {
    const cbJson = (await cbRes.json()) as {
      data?: { amount?: string };
    };
    const parsed = cbJson.data?.amount ? Number(cbJson.data.amount) : NaN;
    if (Number.isFinite(parsed) && parsed > 0) {
      return { priceUsd: parsed, source: "coinbase" };
    }
  }

  throw new Error(`Unable to resolve live USD spot price for asset "${symbol}".`);
}

async function fetchHistoricalDayPriceUsd(
  symbol: string,
  isoDate: string,
  alchemyApiKey: string
): Promise<number | null> {
  try {
    const dayStart = new Date(`${isoDate.slice(0, 10)}T00:00:00.000Z`);
    const dayEnd = new Date(dayStart.getTime() + 86_400_000);
    const res = await fetch(
      `https://api.g.alchemy.com/prices/v1/${encodeURIComponent(alchemyApiKey)}/tokens/historical`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          symbol: normalizeSymbol(symbol),
          startTime: dayStart.toISOString(),
          endTime: dayEnd.toISOString(),
          interval: "1d",
        }),
      }
    );
    if (!res.ok) return null;
    const json = (await res.json()) as {
      data?: Array<{ value?: string }>;
    };
    const val = json.data?.[0]?.value ? Number(json.data[0].value) : NaN;
    return Number.isFinite(val) && val > 0 ? val : null;
  } catch {
    return null;
  }
}

interface AlchemyTransfer {
  hash?: string;
  asset?: string | null;
  value?: number | null;
  metadata?: {
    blockTimestamp?: string;
  };
}

/**
 * Queries Alchemy `alchemy_getAssetTransfers` and price APIs to reconstruct incoming
 * tax lots automatically from a public EVM wallet address.
 */
export async function fetchWalletLotsFromAlchemy(params: {
  walletAddress: string;
  chain: SupportedChain;
  targetAsset: string;
  alchemyApiKey?: string;
}): Promise<{
  lots: TaxLot[];
  currentPriceUsd: number;
  priceSource: "alchemy" | "coinbase";
  warnings: string[];
}> {
  if (!params.alchemyApiKey) {
    throw new Error(
      "Automatic wallet scanning requires ALCHEMY_API_KEY, or pass explicit `lots` and `currentPriceUsd`."
    );
  }
  if (!isEvmChain(params.chain)) {
    throw new Error(
      `Automatic wallet scanning is currently supported on EVM chains (base, ethereum, arbitrum); received "${params.chain}".`
    );
  }

  const rpcUrl = `${ALCHEMY_RPC_HOSTS[params.chain]}/${params.alchemyApiKey}`;
  const [spot, rpcRes] = await Promise.all([
    fetchSpotPriceUsd(params.targetAsset, params.alchemyApiKey),
    fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "alchemy_getAssetTransfers",
        params: [
          {
            fromBlock: "0x0",
            toAddress: params.walletAddress,
            category: ["external", "erc20"],
            withMetadata: true,
            excludeZeroValue: true,
            order: "asc",
            maxCount: "0x64",
          },
        ],
      }),
    }),
  ]);

  if (!rpcRes.ok) {
    throw new Error(`Alchemy RPC error (${rpcRes.status}) scanning wallet transfers.`);
  }

  const rpcJson = (await rpcRes.json()) as {
    result?: { transfers?: AlchemyTransfer[] };
    error?: { message?: string };
  };

  if (rpcJson.error) {
    throw new Error(`Alchemy RPC rejected scan: ${rpcJson.error.message ?? "unknown error"}`);
  }

  const targetNorm = normalizeSymbol(params.targetAsset);
  const transfers = (rpcJson.result?.transfers ?? []).filter((t) => {
    if (!t.asset || !t.value || t.value <= 0) return false;
    return normalizeSymbol(t.asset) === targetNorm;
  });

  if (transfers.length === 0) {
    throw new Error(
      `No incoming ${params.targetAsset} transfers found for ${params.walletAddress} on ${params.chain}. Provide explicit \`lots\` if custody is elsewhere.`
    );
  }

  const warnings: string[] = [];
  const priceByDayCache = new Map<string, number | null>();
  const lots: TaxLot[] = [];
  let missingHistoricalCount = 0;

  for (let i = 0; i < transfers.length; i++) {
    const t = transfers[i]!;
    const acquiredAt = t.metadata?.blockTimestamp || new Date().toISOString();
    const dayKey = acquiredAt.slice(0, 10);

    if (!priceByDayCache.has(dayKey)) {
      // Cap historical API calls per scan at 10 distinct days to keep edge latency <1s
      if (priceByDayCache.size < 10) {
        const hist = await fetchHistoricalDayPriceUsd(
          params.targetAsset,
          acquiredAt,
          params.alchemyApiKey
        );
        priceByDayCache.set(dayKey, hist);
      } else {
        priceByDayCache.set(dayKey, null);
      }
    }

    const histPrice = priceByDayCache.get(dayKey) ?? null;
    if (histPrice === null) {
      missingHistoricalCount++;
    }

    lots.push({
      lotId: `onchain_${params.chain}_${t.hash?.slice(0, 10) ?? i}_${i}`,
      asset: params.targetAsset.toUpperCase(),
      quantity: Number(t.value),
      costBasisUsd: histPrice ?? spot.priceUsd,
      acquiredAt,
      custodyLocation: "SELF_CUSTODY",
    });
  }

  if (missingHistoricalCount > 0) {
    warnings.push(
      `${missingHistoricalCount} on-chain lot(s) used current spot price as fallback cost basis because historical day pricing was unavailable.`
    );
  }

  return {
    lots,
    currentPriceUsd: spot.priceUsd,
    priceSource: spot.source,
    warnings,
  };
}

/**
 * Fetches a live Swap API v2 price/quote from 0x with TaxRail's dynamic integrator fee attached.
 */
export async function fetchLive0xQuote(params: {
  chain: SupportedChain;
  sellAsset: string;
  buyAsset: string;
  sellAmountDecimal: string;
  takerAddress?: string;
  swapFeeBps: number;
  swapFeeRecipient: string;
  zeroxApiKey?: string;
}): Promise<{ quote?: Record<string, unknown>; note?: string }> {
  if (!params.zeroxApiKey) {
    return { note: "ZEROX_API_KEY not configured; returning unsigned template." };
  }
  if (!isEvmChain(params.chain)) {
    return { note: `0x Swap API v2 applies to EVM chains; skipped for ${params.chain}.` };
  }

  const tokens = ZEROX_TOKEN_ADDRESSES[params.chain];
  const sellToken = tokens[params.sellAsset.trim().toUpperCase()];
  const buyToken = tokens[params.buyAsset.trim().toUpperCase()];
  if (!sellToken || !buyToken) {
    return {
      note: `Live 0x token mapping unavailable for ${params.sellAsset}->${params.buyAsset} on ${params.chain}.`,
    };
  }

  const sellAmount = decimalToAtomicString(params.sellAmountDecimal, sellToken.decimals);
  if (sellAmount === "0") {
    return { note: "Sell amount rounds to 0 atomic units." };
  }

  const hasTaker =
    Boolean(params.takerAddress) && /^0x[a-fA-F0-9]{40}$/.test(params.takerAddress!);
  const endpoint = hasTaker
    ? "https://api.0x.org/swap/allowance-holder/quote"
    : "https://api.0x.org/swap/allowance-holder/price";

  const query = new URLSearchParams({
    chainId: String(CHAIN_IDS[params.chain]),
    sellToken: sellToken.address,
    buyToken: buyToken.address,
    sellAmount,
  });

  if (hasTaker && params.takerAddress) {
    query.set("taker", params.takerAddress);
  }
  if (params.swapFeeBps > 0) {
    query.set("swapFeeBps", String(Math.min(100, Math.round(params.swapFeeBps))));
    query.set("swapFeeRecipient", params.swapFeeRecipient);
    query.set("swapFeeToken", buyToken.address);
  }

  try {
    const res = await fetch(`${endpoint}?${query.toString()}`, {
      headers: {
        "0x-api-key": params.zeroxApiKey,
        "0x-version": "v2",
        Accept: "application/json",
      },
    });
    const body = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      return {
        note: `0x API returned HTTP ${res.status}: ${String(body.message ?? body.reason ?? "quote unavailable")}`,
      };
    }
    return {
      quote: {
        endpoint: hasTaker ? "quote" : "price",
        chainId: CHAIN_IDS[params.chain],
        buyAmount: body.buyAmount,
        minBuyAmount: body.minBuyAmount,
        liquidityAvailable: body.liquidityAvailable,
        transaction: body.transaction,
        issues: body.issues,
      },
    };
  } catch (err) {
    return {
      note: err instanceof Error ? `0x live quote failed: ${err.message}` : "0x live quote failed.",
    };
  }
}
