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
    USDT: { address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", decimals: 6 },
    WBTC: { address: "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c", decimals: 8 },
    CBBTC: { address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", decimals: 8 },
    WSTETH: { address: "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452", decimals: 18 },
    CBETH: { address: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", decimals: 18 },
  },
  ethereum: {
    ETH: { address: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", decimals: 18 },
    WETH: { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", decimals: 18 },
    USDC: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
    USDT: { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 },
    WBTC: { address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", decimals: 8 },
    CBBTC: { address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", decimals: 8 },
    WSTETH: { address: "0x7f39C581F595B53c5cb19bD0b3F8dA6c935E2Ca0", decimals: 18 },
    CBETH: { address: "0xBe9895146f7AF43049ca1c1AE358B0541Ea49704", decimals: 18 },
  },
  arbitrum: {
    ETH: { address: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", decimals: 18 },
    WETH: { address: "0x82aF49447d8a07e3bd95BD0d56f35241523fBab1", decimals: 18 },
    USDC: { address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6 },
    USDT: { address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", decimals: 6 },
    WBTC: { address: "0x2f2a2543B76A4166549F7aAb2E75BeF0aEFC5B0f", decimals: 8 },
    CBBTC: { address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", decimals: 8 },
    WSTETH: { address: "0x5979D7b546E38E414F7E9822514be443A4800529", decimals: 18 },
  },
};

const PUBLIC_EVM_RPC_HOSTS: Record<EvmChain, string> = {
  base: "https://mainnet.base.org",
  ethereum: "https://eth.llamarpc.com",
  arbitrum: "https://arb1.arbitrum.io/rpc",
};

const EVM_EXPLORER_TX_BASE: Record<EvmChain, string> = {
  base: "https://basescan.org/tx/",
  ethereum: "https://etherscan.io/tx/",
  arbitrum: "https://arbiscan.io/tx/",
};

const ERC20_TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export function resolveZeroXTokenInfo(
  chain: SupportedChain,
  asset: string
): { address: string; decimals: number } | null {
  if (!isEvmChain(chain)) return null;
  return ZEROX_TOKEN_ADDRESSES[chain][asset.trim().toUpperCase()] ?? null;
}

export function getExplorerTxUrl(chain: SupportedChain, txHash: string): string {
  const base = isEvmChain(chain) ? EVM_EXPLORER_TX_BASE[chain] : EVM_EXPLORER_TX_BASE.base;
  return `${base}${txHash}`;
}

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

const STABLECOIN_SYMBOLS = new Set([
  "USDC",
  "USDT",
  "DAI",
  "USDBC",
  "EURC",
  "USDE",
  "PYUSD",
  "TUSD",
  "FRAX",
  "BUSD",
]);

const LIQUID_ASSET_PRIORITY = [
  "ETH",
  "CBBTC",
  "WBTC",
  "CBETH",
  "WSTETH",
  "AERO",
  "LINK",
  "UNI",
  "AAVE",
  "VIRTUAL",
  "DEGEN",
];

function isValidVolatileSymbol(normSymbol: string): boolean {
  return (
    /^[A-Z0-9]{2,10}$/.test(normSymbol) &&
    !STABLECOIN_SYMBOLS.has(normSymbol)
  );
}

async function fetchTransfersFromAlchemy(params: {
  walletAddress: string;
  chain: EvmChain;
  alchemyApiKey: string;
  order: "asc" | "desc";
}): Promise<AlchemyTransfer[]> {
  const rpcUrl = `${ALCHEMY_RPC_HOSTS[params.chain]}/${params.alchemyApiKey}`;
  const rpcRes = await fetch(rpcUrl, {
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
          order: params.order,
          maxCount: "0x64",
        },
      ],
    }),
  });

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

  return rpcJson.result?.transfers ?? [];
}

async function reconstructLotsFromTransfers(params: {
  chain: SupportedChain;
  assetLabel: string;
  spotPriceUsd: number;
  transfers: AlchemyTransfer[];
  alchemyApiKey: string;
  historicalBudget: { remaining: number };
}): Promise<{ lots: TaxLot[]; warning?: string }> {
  const priceByDayCache = new Map<string, number | null>();
  const lots: TaxLot[] = [];
  let missingHistoricalCount = 0;

  for (let i = 0; i < params.transfers.length; i++) {
    const t = params.transfers[i]!;
    const acquiredAt = t.metadata?.blockTimestamp || new Date().toISOString();
    const dayKey = `${params.assetLabel}:${acquiredAt.slice(0, 10)}`;

    if (!priceByDayCache.has(dayKey)) {
      if (params.historicalBudget.remaining > 0) {
        params.historicalBudget.remaining -= 1;
        const hist = await fetchHistoricalDayPriceUsd(
          params.assetLabel,
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
      asset: params.assetLabel,
      quantity: Number(t.value),
      costBasisUsd: histPrice ?? params.spotPriceUsd,
      acquiredAt,
      custodyLocation: "SELF_CUSTODY",
    });
  }

  return {
    lots,
    warning:
      missingHistoricalCount > 0
        ? `${missingHistoricalCount} on-chain ${params.assetLabel} lot(s) used current spot price as fallback cost basis because historical day pricing was unavailable.`
        : undefined,
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

  const [spot, allTransfers] = await Promise.all([
    fetchSpotPriceUsd(params.targetAsset, params.alchemyApiKey),
    fetchTransfersFromAlchemy({
      walletAddress: params.walletAddress,
      chain: params.chain,
      alchemyApiKey: params.alchemyApiKey,
      order: "asc",
    }),
  ]);

  const targetNorm = normalizeSymbol(params.targetAsset);
  const transfers = allTransfers.filter((t) => {
    if (!t.asset || !t.value || t.value <= 0) return false;
    return normalizeSymbol(t.asset) === targetNorm;
  });

  if (transfers.length === 0) {
    throw new Error(
      `No incoming ${params.targetAsset} transfers found for ${params.walletAddress} on ${params.chain}. Provide explicit \`lots\` if custody is elsewhere.`
    );
  }

  const { lots, warning } = await reconstructLotsFromTransfers({
    chain: params.chain,
    assetLabel: params.targetAsset.toUpperCase(),
    spotPriceUsd: spot.priceUsd,
    transfers,
    alchemyApiKey: params.alchemyApiKey,
    historicalBudget: { remaining: 10 },
  });

  return {
    lots,
    currentPriceUsd: spot.priceUsd,
    priceSource: spot.source,
    warnings: warning ? [warning] : [],
  };
}

export interface PortfolioAssetLots {
  asset: string;
  currentPriceUsd: number;
  priceSource: "alchemy" | "coinbase";
  lots: TaxLot[];
  warnings: string[];
}

/**
 * Multi-asset portfolio scanner: with a single `alchemy_getAssetTransfers` call, discovers
 * up to 5 liquid volatile tokens (or a single specified `targetAsset`) and reconstructs
 * chronological tax lots with historical cost basis.
 */
export async function fetchWalletPortfolioFromAlchemy(params: {
  walletAddress: string;
  chain: SupportedChain;
  targetAsset?: string;
  alchemyApiKey?: string;
}): Promise<{ assets: PortfolioAssetLots[]; warnings: string[] }> {
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

  const requestedAsset = params.targetAsset?.trim().toUpperCase();
  if (requestedAsset && requestedAsset !== "ALL") {
    const single = await fetchWalletLotsFromAlchemy({
      walletAddress: params.walletAddress,
      chain: params.chain,
      targetAsset: requestedAsset,
      alchemyApiKey: params.alchemyApiKey,
    });
    return {
      assets: [
        {
          asset: requestedAsset,
          currentPriceUsd: single.currentPriceUsd,
          priceSource: single.priceSource,
          lots: single.lots,
          warnings: single.warnings,
        },
      ],
      warnings: [],
    };
  }

  const recentTransfers = await fetchTransfersFromAlchemy({
    walletAddress: params.walletAddress,
    chain: params.chain,
    alchemyApiKey: params.alchemyApiKey,
    order: "desc",
  });

  const grouped = new Map<string, AlchemyTransfer[]>();
  for (const t of recentTransfers) {
    if (!t.asset || !t.value || t.value <= 0) continue;
    const norm = normalizeSymbol(t.asset);
    if (!isValidVolatileSymbol(norm)) continue;
    const bucket = grouped.get(norm);
    if (bucket) {
      bucket.push(t);
    } else {
      grouped.set(norm, [t]);
    }
  }

  if (grouped.size === 0) {
    return {
      assets: [],
      warnings: [
        `No incoming volatile token transfers found for ${params.walletAddress} on ${params.chain}.`,
      ],
    };
  }

  const rankedSymbols = Array.from(grouped.keys())
    .sort((a, b) => {
      const idxA = LIQUID_ASSET_PRIORITY.indexOf(a);
      const idxB = LIQUID_ASSET_PRIORITY.indexOf(b);
      if (idxA !== -1 && idxB !== -1) return idxA - idxB;
      if (idxA !== -1) return -1;
      if (idxB !== -1) return 1;
      return (grouped.get(b)?.length ?? 0) - (grouped.get(a)?.length ?? 0);
    })
    .slice(0, 25);

  const spotMap = await fetchBatchSpotPricesUsd(rankedSymbols, params.alchemyApiKey);
  const historicalBudget = { remaining: 14 };
  const assets: PortfolioAssetLots[] = [];

  for (const sym of rankedSymbols) {
    const spot = spotMap.get(sym);
    if (!spot) continue;
    const transfersChronological = [...(grouped.get(sym) ?? [])].reverse();
    if (transfersChronological.length === 0) continue;

    const { lots, warning } = await reconstructLotsFromTransfers({
      chain: params.chain,
      assetLabel: sym,
      spotPriceUsd: spot.priceUsd,
      transfers: transfersChronological,
      alchemyApiKey: params.alchemyApiKey,
      historicalBudget,
    });

    assets.push({
      asset: sym,
      currentPriceUsd: spot.priceUsd,
      priceSource: spot.source,
      lots,
      warnings: warning ? [warning] : [],
    });
  }

  return { assets, warnings: [] };
}

/**
 * Fetches USD spot prices for up to 25 tokens in a single Alchemy Prices API call,
 * keeping Cloudflare Workers subrequest usage tiny during multi-asset wallet scans.
 */
export async function fetchBatchSpotPricesUsd(
  symbols: string[],
  alchemyApiKey?: string
): Promise<Map<string, { priceUsd: number; source: "alchemy" | "coinbase" }>> {
  const result = new Map<string, { priceUsd: number; source: "alchemy" | "coinbase" }>();
  const uniqueSymbols = Array.from(
    new Set(symbols.map((s) => normalizeSymbol(s)).filter(Boolean))
  ).slice(0, 25);

  if (uniqueSymbols.length === 0) return result;

  if (alchemyApiKey) {
    try {
      const query = new URLSearchParams();
      for (const sym of uniqueSymbols) {
        query.append("symbols", sym);
      }
      const url = `https://api.g.alchemy.com/prices/v1/${encodeURIComponent(
        alchemyApiKey
      )}/tokens/by-symbol?${query.toString()}`;
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
        for (const entry of json.data ?? []) {
          const sym = entry.symbol ? normalizeSymbol(entry.symbol) : "";
          const usdEntry = entry.prices?.find(
            (p) => p.currency?.toUpperCase() === "USD" && p.value
          );
          const parsed = usdEntry?.value ? Number(usdEntry.value) : NaN;
          if (sym && Number.isFinite(parsed) && parsed > 0) {
            result.set(sym, { priceUsd: parsed, source: "alchemy" });
          }
        }
        if (result.size > 0) {
          return result;
        }
      }
    } catch {
      // Fall through to bounded Coinbase fallback below
    }
  }

  // Fallback for up to 3 top symbols if Alchemy batch is unavailable
  const fallbackTargets = uniqueSymbols.slice(0, 3);
  const settled = await Promise.allSettled(
    fallbackTargets.map(async (sym) => ({
      sym,
      spot: await fetchSpotPriceUsd(sym, alchemyApiKey),
    }))
  );
  for (const item of settled) {
    if (item.status === "fulfilled") {
      result.set(item.value.sym, item.value.spot);
    }
  }
  return result;
}

/**
 * Fetches a live Swap API v2 price/quote from 0x with TaxRail's dynamic integrator fee attached
 * (up to 1000 bps / 10%, with optional 80/20 comma-separated multi-recipient affiliate split).
 */
export async function fetchLive0xQuote(params: {
  chain: SupportedChain;
  sellAsset: string;
  buyAsset: string;
  sellAmountDecimal: string;
  takerAddress?: string;
  swapFeeBps: number;
  swapFeeRecipient: string;
  affiliateWallet?: string;
  zeroxApiKey?: string;
}): Promise<{ quote?: Record<string, unknown>; note?: string }> {
  if (!params.zeroxApiKey) {
    return { note: "ZEROX_API_KEY not configured; returning unsigned template." };
  }
  if (!isEvmChain(params.chain)) {
    return { note: `0x Swap API v2 applies to EVM chains; skipped for ${params.chain}.` };
  }
  const evmChain: EvmChain = params.chain;

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

  const clampedFeeBps = Math.min(1000, Math.max(0, Math.round(params.swapFeeBps)));
  const trimmedAff = params.affiliateWallet?.trim();
  const canSplitAffiliate =
    Boolean(trimmedAff) &&
    /^0x[a-fA-F0-9]{40}$/.test(trimmedAff!) &&
    trimmedAff!.toLowerCase() !== params.swapFeeRecipient.toLowerCase() &&
    clampedFeeBps >= 2;

  const buildQuoteUrl = (useMultiRecipientSplit: boolean): string => {
    const query = new URLSearchParams({
      chainId: String(CHAIN_IDS[evmChain]),
      sellToken: sellToken.address,
      buyToken: buyToken.address,
      sellAmount,
    });
    if (hasTaker && params.takerAddress) {
      query.set("taker", params.takerAddress);
    }
    if (clampedFeeBps > 0) {
      if (useMultiRecipientSplit && trimmedAff) {
        const affiliateBps = Math.max(1, Math.round(clampedFeeBps * 0.2));
        const treasuryBps = Math.max(1, clampedFeeBps - affiliateBps);
        query.set("swapFeeBps", `${treasuryBps},${affiliateBps}`);
        query.set("swapFeeRecipient", `${params.swapFeeRecipient},${trimmedAff}`);
      } else {
        query.set("swapFeeBps", String(clampedFeeBps));
        query.set("swapFeeRecipient", params.swapFeeRecipient);
      }
      query.set("swapFeeToken", buyToken.address);
    }
    return `${endpoint}?${query.toString()}`;
  };

  try {
    const headers = {
      "0x-api-key": params.zeroxApiKey,
      "0x-version": "v2",
      Accept: "application/json",
    };

    let usedMultiRecipient = canSplitAffiliate;
    let res = await fetch(buildQuoteUrl(usedMultiRecipient), { headers });
    let body = (await res.json()) as Record<string, unknown>;

    if (!res.ok && usedMultiRecipient) {
      usedMultiRecipient = false;
      res = await fetch(buildQuoteUrl(false), { headers });
      body = (await res.json()) as Record<string, unknown>;
    }

    if (!res.ok) {
      return {
        note: `0x API returned HTTP ${res.status}: ${String(body.message ?? body.reason ?? "quote unavailable")}`,
      };
    }
    const issuesObj =
      body.issues && typeof body.issues === "object"
        ? (body.issues as { allowance?: { spender?: string } | null })
        : undefined;
    return {
      quote: {
        endpoint: hasTaker ? "quote" : "price",
        chainId: CHAIN_IDS[params.chain],
        sellTokenAddress: sellToken.address,
        sellTokenDecimals: sellToken.decimals,
        buyTokenAddress: buyToken.address,
        buyTokenDecimals: buyToken.decimals,
        buyAmount: body.buyAmount,
        minBuyAmount: body.minBuyAmount,
        liquidityAvailable: body.liquidityAvailable,
        fees: body.fees,
        multiRecipientSplitApplied: usedMultiRecipient,
        allowanceTarget: issuesObj?.allowance?.spender ?? null,
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

/**
 * Verifies on-chain via `eth_getTransactionReceipt` that a settled swap or Aave borrow batch
 * succeeded (`status === 0x1`) and delivered the expected fee token transfer to `treasuryWallet`.
 */
export async function verifyOperationFeeReceipt(params: {
  chain: EvmChain;
  txHash: string;
  treasuryWallet: string;
  expectedTokenAddress?: string;
  expectedMinAtomic?: bigint;
  alchemyApiKey?: string;
}): Promise<
  | { verified: true; receivedAtomic: string; explorerUrl: string }
  | { verified: false; reason: string; explorerUrl: string }
> {
  const explorerUrl = getExplorerTxUrl(params.chain, params.txHash);
  const rpcUrl = params.alchemyApiKey
    ? `${ALCHEMY_RPC_HOSTS[params.chain]}/${params.alchemyApiKey}`
    : PUBLIC_EVM_RPC_HOSTS[params.chain];

  interface RpcReceipt {
    status?: string;
    logs?: Array<{
      address?: string;
      topics?: string[];
      data?: string;
    }>;
  }

  let receipt: RpcReceipt | null = null;

  try {
    const rpcRes = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getTransactionReceipt",
        params: [params.txHash],
      }),
    });
    if (!rpcRes.ok) {
      return {
        verified: false,
        reason: `RPC HTTP ${rpcRes.status} fetching transaction receipt on ${params.chain}.`,
        explorerUrl,
      };
    }
    const json = (await rpcRes.json()) as {
      result?: RpcReceipt | null;
      error?: { message?: string };
    };
    if (json.error) {
      return {
        verified: false,
        reason: `RPC error: ${json.error.message ?? "unknown error"}`,
        explorerUrl,
      };
    }
    receipt = json.result ?? null;
  } catch (err) {
    return {
      verified: false,
      reason: err instanceof Error ? err.message : "Failed to query on-chain receipt.",
      explorerUrl,
    };
  }

  if (!receipt) {
    return {
      verified: false,
      reason: `Transaction ${params.txHash} is not yet mined on ${params.chain}. Wait a few seconds and retry.`,
      explorerUrl,
    };
  }

  if (receipt.status !== "0x1") {
    return {
      verified: false,
      reason: `Transaction ${params.txHash} reverted on ${params.chain} (status=${receipt.status ?? "unknown"}).`,
      explorerUrl,
    };
  }

  const treasuryClean = params.treasuryWallet.trim().toLowerCase().replace(/^0x/, "");
  const expectedTokenLower = params.expectedTokenAddress?.trim().toLowerCase();
  const filterByToken =
    Boolean(expectedTokenLower) &&
    expectedTokenLower !== "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

  let receivedAtomic = 0n;
  for (const log of receipt.logs ?? []) {
    const topics = log.topics ?? [];
    if (
      topics.length >= 3 &&
      topics[0]?.toLowerCase() === ERC20_TRANSFER_TOPIC &&
      topics[2]?.toLowerCase().endsWith(treasuryClean)
    ) {
      if (filterByToken && log.address?.toLowerCase() !== expectedTokenLower) {
        continue;
      }
      try {
        if (log.data && /^0x[0-9a-fA-F]+$/.test(log.data)) {
          receivedAtomic += BigInt(log.data);
        }
      } catch {
        // Ignore malformed log data
      }
    }
  }

  if (receivedAtomic <= 0n) {
    return {
      verified: false,
      reason: `No fee transfer to TaxRail treasury (${params.treasuryWallet}) found in transaction ${params.txHash}.`,
      explorerUrl,
    };
  }

  if (params.expectedMinAtomic && params.expectedMinAtomic > 0n && receivedAtomic < params.expectedMinAtomic) {
    return {
      verified: false,
      reason: `Fee transfer in ${params.txHash} (${receivedAtomic.toString()} atomic) is below required minimum (${params.expectedMinAtomic.toString()} atomic).`,
      explorerUrl,
    };
  }

  return {
    verified: true,
    receivedAtomic: receivedAtomic.toString(),
    explorerUrl,
  };
}
