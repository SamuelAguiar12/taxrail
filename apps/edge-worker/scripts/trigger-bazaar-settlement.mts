import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const BASE_URL = (process.env.TAXRAIL_BASE_URL || "https://api.taxrail.online").replace(
  /\/$/,
  ""
);

type EndpointTarget = "unlock" | "tlh-scan" | "optimize" | "all";

function parseArgs(): { live: boolean; dryRun: boolean; endpoint: EndpointTarget } {
  const args = process.argv.slice(2);
  const endpointArg = args.find((a) => a.startsWith("--endpoint="))?.split("=")[1];
  const endpoint: EndpointTarget =
    endpointArg === "tlh-scan" ||
    endpointArg === "optimize" ||
    endpointArg === "all" ||
    endpointArg === "unlock"
      ? endpointArg
      : "unlock";
  return {
    live: args.includes("--live"),
    dryRun: args.includes("--dry-run") || !args.includes("--live"),
    endpoint,
  };
}

async function runPaidCall(params: {
  label: string;
  url: string;
  method: "GET" | "POST";
  body?: unknown;
  live: boolean;
  rawPrivateKey?: string;
}) {
  const { label, url, method, body, live, rawPrivateKey } = params;
  console.log(`\n[${label}] Probing ${method} ${url}...`);

  const probeRes = await fetch(url, {
    method,
    headers: method === "POST" ? { "Content-Type": "application/json" } : undefined,
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
  });

  if (probeRes.status !== 402) {
    throw new Error(`${label}: expected HTTP 402, received ${probeRes.status}`);
  }

  const unpaidBody = (await probeRes.json()) as Record<string, unknown>;
  const client = new x402Client();
  const httpClient = new x402HTTPClient(client);
  const paymentRequired = httpClient.getPaymentRequiredResponse(
    (h) => probeRes.headers.get(h),
    unpaidBody
  );

  const accept = paymentRequired.accepts[0];
  console.log(
    `   HTTP 402 -> amount=${accept?.amount} atomic (${(
      Number(accept?.amount ?? 0) / 1_000_000
    ).toFixed(2)} USDC) | network=${accept?.network} | bazaar=${Boolean(
      paymentRequired.extensions?.bazaar
    )}`
  );

  if (!live || !rawPrivateKey) {
    return;
  }

  const normalizedKey = (
    rawPrivateKey.startsWith("0x") ? rawPrivateKey : `0x${rawPrivateKey}`
  ) as `0x${string}`;
  const account = privateKeyToAccount(normalizedKey);
  registerExactEvmScheme(client, { signer: account });

  const paymentPayload = await httpClient.createPaymentPayload(paymentRequired);
  const sigHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);

  const paidRes = await fetch(url, {
    method,
    headers: {
      ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
      ...sigHeaders,
    },
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
  });

  const paidText = await paidRes.text();
  if (!paidRes.ok) {
    throw new Error(`${label} paid call failed (${paidRes.status}): ${paidText}`);
  }

  try {
    const settleInfo = httpClient.getPaymentSettleResponse((h) =>
      paidRes.headers.get(h)
    );
    console.log(`   Settled! tx=${(settleInfo as { transaction?: string }).transaction}`);
  } catch {
    console.log("   Succeeded (HTTP 200)");
  }
}

/**
 * Generates and optionally settles live Base USDC x402 payments across TaxRail endpoints
 * (`unlock` = $0.80, `tlh-scan` = $0.01, `optimize` = $0.10, `all` = tlh-scan + optimize = $0.11).
 */
async function main() {
  const { live, endpoint } = parseArgs();
  const rawPrivateKey = process.env.TEST_PRIVATE_KEY?.trim();

  console.log(`\n[TaxRail Bazaar Settlement] Target: ${BASE_URL} | endpoint=${endpoint}`);

  if (endpoint === "tlh-scan" || endpoint === "all") {
    await runPaidCall({
      label: "$0.01 TLH Scan",
      url: `${BASE_URL}/api/v1/x402/tlh-scan?walletAddress=0x849151d7D0bF1F34b70d5caD5149D28CC2308bf1&chain=base&asset=ALL`,
      method: "GET",
      live,
      rawPrivateKey,
    });
  }

  if (endpoint === "optimize" || endpoint === "all") {
    await runPaidCall({
      label: "$0.10 Quick Optimize",
      url: `${BASE_URL}/api/v1/x402/optimize`,
      method: "POST",
      body: {
        jurisdiction: "US",
        regime: "INDIVIDUAL",
        chain: "base",
        targetAsset: "ETH",
        sellQuantity: 0.05,
        currentPriceUsd: 3000,
        targetQuoteAsset: "USDC",
        asOfDate: "2026-06-01T00:00:00Z",
        lots: [
          {
            lotId: "bazaar-opt-fifo",
            asset: "ETH",
            quantity: 0.05,
            costBasisUsd: 2400,
            acquiredAt: "2026-03-01T00:00:00Z",
            custodyLocation: "SELF_CUSTODY",
          },
          {
            lotId: "bazaar-opt-hifo",
            asset: "ETH",
            quantity: 0.05,
            costBasisUsd: 2900,
            acquiredAt: "2026-04-01T00:00:00Z",
            custodyLocation: "SELF_CUSTODY",
          },
        ],
      },
      live,
      rawPrivateKey,
    });
  }

  if (endpoint !== "unlock") {
    if (!live || !rawPrivateKey) {
      console.log("\n[Dry-Run Complete]");
      console.log(
        `Run live with:\n  TEST_PRIVATE_KEY=0xYOUR_KEY pnpm bazaar:settle -- --live --endpoint=${endpoint}`
      );
    }
    return;
  }

  console.log("1. Creating minimal $0.50 USDC optimization plan via /api/v1/check-tax-impact...");

  const previewRes = await fetch(`${BASE_URL}/api/v1/check-tax-impact`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jurisdiction: "US",
      regime: "INDIVIDUAL",
      chain: "base",
      targetAsset: "ETH",
      sellQuantity: 0.05,
      currentPriceUsd: 3000,
      targetQuoteAsset: "USDC",
      asOfDate: "2026-06-01T00:00:00Z",
      lots: [
        {
          lotId: "bazaar-seed-fifo",
          asset: "ETH",
          quantity: 0.05,
          costBasisUsd: 2400,
          acquiredAt: "2026-03-01T00:00:00Z",
          custodyLocation: "SELF_CUSTODY",
        },
        {
          lotId: "bazaar-seed-hifo",
          asset: "ETH",
          quantity: 0.05,
          costBasisUsd: 2900,
          acquiredAt: "2026-04-01T00:00:00Z",
          custodyLocation: "SELF_CUSTODY",
        },
      ],
    }),
  });

  if (!previewRes.ok) {
    throw new Error(`Preview failed (${previewRes.status}): ${await previewRes.text()}`);
  }

  const preview = (await previewRes.json()) as {
    planId: string;
    taxSavedUsd: number;
    pricing: { upfrontX402Usd: number };
  };

  console.log(
    `   planId=${preview.planId} | taxSaved=$${preview.taxSavedUsd.toFixed(
      2
    )} | upfrontX402Fee=$${preview.pricing.upfrontX402Usd.toFixed(2)} USDC`
  );

  console.log("2. Requesting /api/v1/unlock-plan without payment to inspect x402 challenge...");
  const unpaidRes = await fetch(`${BASE_URL}/api/v1/unlock-plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ planId: preview.planId }),
  });

  if (unpaidRes.status !== 402) {
    throw new Error(`Expected HTTP 402, received ${unpaidRes.status}`);
  }

  const unpaidBody = (await unpaidRes.json()) as Record<string, unknown>;
  const client = new x402Client();
  const httpClient = new x402HTTPClient(client);
  const paymentRequired = httpClient.getPaymentRequiredResponse(
    (h) => unpaidRes.headers.get(h),
    unpaidBody
  );

  const accept = paymentRequired.accepts[0];
  console.log(
    `   HTTP 402 received -> amount=${accept?.amount} atomic (${(
      Number(accept?.amount ?? 0) / 1_000_000
    ).toFixed(2)} USDC) | network=${accept?.network} | payTo=${accept?.payTo}`
  );
  console.log(
    `   Bazaar extension attached: ${Boolean(paymentRequired.extensions?.bazaar)}`
  );

  if (!live || !rawPrivateKey) {
    console.log("\n[Dry-Run Complete]");
    console.log("To execute the real $0.50 USDC settlement on Base and index in x402 Bazaar:");
    console.log(
      "  TEST_PRIVATE_KEY=0xYOUR_BASE_WALLET_PRIVATE_KEY pnpm bazaar:settle -- --live"
    );
    return;
  }

  const normalizedKey = (
    rawPrivateKey.startsWith("0x") ? rawPrivateKey : `0x${rawPrivateKey}`
  ) as `0x${string}`;
  const account = privateKeyToAccount(normalizedKey);
  registerExactEvmScheme(client, { signer: account });

  console.log(`\n3. Signing x402 USDC payment from ${account.address}...`);
  const paymentPayload = await httpClient.createPaymentPayload(paymentRequired);
  const sigHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);

  console.log("4. Submitting signed PAYMENT-SIGNATURE to /api/v1/unlock-plan...");
  const paidRes = await fetch(`${BASE_URL}/api/v1/unlock-plan`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...sigHeaders,
    },
    body: JSON.stringify({ planId: preview.planId }),
  });

  const paidText = await paidRes.text();
  if (!paidRes.ok) {
    throw new Error(`Paid unlock failed (${paidRes.status}): ${paidText}`);
  }

  try {
    const settleInfo = httpClient.getPaymentSettleResponse((h) =>
      paidRes.headers.get(h)
    );
    console.log("5. Settlement confirmed!", JSON.stringify(settleInfo, null, 2));
  } catch {
    console.log("5. Plan unlocked! (PAYMENT-RESPONSE header not decoded)");
  }

  const unlocked = JSON.parse(paidText) as {
    planId: string;
    selectedLots?: unknown[];
    accountingDossier?: { format?: string };
  };
  console.log(
    `   Unlocked plan ${unlocked.planId} | lots=${
      unlocked.selectedLots?.length ?? 0
    } | dossier=${unlocked.accountingDossier?.format}`
  );
  console.log(
    "\nWait ~60 seconds, then verify Bazaar indexing:\n  curl -s \"https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?limit=100\" | grep -i taxrail"
  );
}

main().catch((err) => {
  console.error("Bazaar settlement failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
