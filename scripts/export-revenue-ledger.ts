import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

type SettlementSource = "x402" | "integrator_fee";

interface RevenueLedgerEntry {
  id: string;
  timestamp: string;
  source: SettlementSource;
  network: string;
  asset: string;
  grossUsd: number;
  affiliateShareUsd?: number;
  txHash?: string;
  planId?: string;
  referrerWallet?: string;
  customerJurisdiction?: string;
}

interface CliOptions {
  filePath?: string;
  demo: boolean;
  ptax: number;
  month?: string;
  help: boolean;
}

const DEFAULT_PTAX = 5.8;

const DEMO_ENTRIES: RevenueLedgerEntry[] = [
  {
    id: "settle-001",
    timestamp: "2026-11-03T14:22:10Z",
    source: "x402",
    network: "eip155:8453",
    asset: "USDC",
    grossUsd: 10.0,
    affiliateShareUsd: 2.0,
    txHash: "0x8a4c1e9f0b23c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9",
    planId: "plan_us_hifo_01",
    referrerWallet: "0xAgentDevWallet00000000000000000000000001",
    customerJurisdiction: "US",
  },
  {
    id: "settle-002",
    timestamp: "2026-11-03T14:24:05Z",
    source: "integrator_fee",
    network: "eip155:8453",
    asset: "USDC",
    grossUsd: 185.0,
    affiliateShareUsd: 37.0,
    txHash: "0x9b5d2f0a1c34d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0",
    planId: "plan_us_hifo_01",
    referrerWallet: "0xAgentDevWallet00000000000000000000000001",
    customerJurisdiction: "US",
  },
  {
    id: "settle-003",
    timestamp: "2026-11-09T18:10:44Z",
    source: "x402",
    network: "eip155:8453",
    asset: "USDC",
    grossUsd: 42.5,
    affiliateShareUsd: 0.0,
    txHash: "0x1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d",
    planId: "plan_us_aave_02",
    customerJurisdiction: "US",
  },
  {
    id: "settle-004",
    timestamp: "2026-11-15T11:05:19Z",
    source: "x402",
    network: "eip155:8453",
    asset: "USDC",
    grossUsd: 10.0,
    affiliateShareUsd: 2.0,
    txHash: "0x3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f",
    planId: "plan_offshore_03",
    referrerWallet: "0xAgentDevWallet00000000000000000000000002",
    customerJurisdiction: "US",
  },
  {
    id: "settle-005",
    timestamp: "2026-11-15T11:08:52Z",
    source: "integrator_fee",
    network: "eip155:8453",
    asset: "USDC",
    grossUsd: 312.5,
    affiliateShareUsd: 62.5,
    txHash: "0x5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b",
    planId: "plan_offshore_03",
    referrerWallet: "0xAgentDevWallet00000000000000000000000002",
    customerJurisdiction: "US",
  },
  {
    id: "settle-006",
    timestamp: "2026-11-22T20:41:00Z",
    source: "x402",
    network: "eip155:8453",
    asset: "USDC",
    grossUsd: 50.0,
    affiliateShareUsd: 10.0,
    txHash: "0x7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d",
    planId: "plan_corp_expense_04",
    referrerWallet: "0xAgentDevWallet00000000000000000000000003",
    customerJurisdiction: "US",
  },
  {
    id: "settle-007",
    timestamp: "2026-11-24T16:15:30Z",
    source: "integrator_fee",
    network: "eip155:8453",
    asset: "USDC",
    grossUsd: 890.0,
    affiliateShareUsd: 178.0,
    txHash: "0x9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f",
    planId: "plan_treasury_rebalance_05",
    referrerWallet: "0xAgentDevWallet00000000000000000000000001",
    customerJurisdiction: "US",
  },
];

function printHelp(): void {
  console.log(`
TaxRail — Exportação de Ledger de Receita (Base USDC x402 & Integrator Fees)

Uso:
  node --experimental-strip-types scripts/export-revenue-ledger.ts [opções]
  npx tsx scripts/export-revenue-ledger.ts [opções]

Opções:
  --file <caminho>     Caminho para arquivo JSON de liquidações (array ou { "entries": [...] })
  --demo               Executa com transações de demonstração (padrão se nenhum arquivo for informado)
  --ptax <taxa>        Taxa USD/BRL PTAX oficial do fechamento (padrão: ${DEFAULT_PTAX.toFixed(2)})
  --month <AAAA-MM>    Filtra lançamentos pelo mês de competência (ex.: 2026-11)
  -h, --help           Exibe esta ajuda
`);
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    demo: false,
    ptax: DEFAULT_PTAX,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else if (arg === "--demo") {
      opts.demo = true;
    } else if (arg === "--file" && argv[i + 1]) {
      opts.filePath = argv[++i];
    } else if (arg === "--ptax" && argv[i + 1]) {
      const parsed = Number(argv[++i]);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Valor inválido para --ptax: ${argv[i]}`);
      }
      opts.ptax = parsed;
    } else if (arg === "--month" && argv[i + 1]) {
      opts.month = argv[++i];
    } else if (!arg.startsWith("-") && !opts.filePath) {
      opts.filePath = arg;
    } else {
      throw new Error(`Argumento desconhecido ou incompleto: ${arg}`);
    }
  }

  if (!opts.filePath) {
    opts.demo = true;
  }

  return opts;
}

function formatUsd(value: number): string {
  return `US$ ${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatBrl(value: number): string {
  return `R$ ${value.toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

async function loadEntries(options: CliOptions): Promise<{
  entries: RevenueLedgerEntry[];
  originLabel: string;
}> {
  if (options.demo && !options.filePath) {
    return {
      entries: DEMO_ENTRIES,
      originLabel: "MODO DEMONSTRAÇÃO (--demo)",
    };
  }

  const absolutePath = resolve(process.cwd(), options.filePath!);
  const raw = await readFile(absolutePath, "utf8");
  const parsed = JSON.parse(raw) as
    | RevenueLedgerEntry[]
    | { entries?: RevenueLedgerEntry[] };

  const list = Array.isArray(parsed) ? parsed : parsed.entries;
  if (!Array.isArray(list)) {
    throw new Error(
      "Formato de ledger inválido. Esperado array JSON ou objeto com propriedade 'entries'."
    );
  }

  return {
    entries: list,
    originLabel: absolutePath,
  };
}

function computeTotals(entries: RevenueLedgerEntry[]) {
  let x402GrossUsd = 0;
  let integratorGrossUsd = 0;
  let affiliatePayoutsUsd = 0;
  let x402Count = 0;
  let integratorCount = 0;

  for (const entry of entries) {
    const gross = Number(entry.grossUsd) || 0;
    const affiliate = Number(entry.affiliateShareUsd) || 0;
    affiliatePayoutsUsd += affiliate;

    if (entry.source === "x402") {
      x402GrossUsd += gross;
      x402Count += 1;
    } else {
      integratorGrossUsd += gross;
      integratorCount += 1;
    }
  }

  const totalGrossUsd = x402GrossUsd + integratorGrossUsd;
  const netAfterAffiliateUsd = totalGrossUsd - affiliatePayoutsUsd;

  return {
    x402GrossUsd,
    x402Count,
    integratorGrossUsd,
    integratorCount,
    totalGrossUsd,
    affiliatePayoutsUsd,
    netAfterAffiliateUsd,
  };
}

function renderReport(
  entries: RevenueLedgerEntry[],
  originLabel: string,
  options: CliOptions
): string {
  const filtered = options.month
    ? entries.filter((item) => item.timestamp.startsWith(options.month!))
    : entries;

  const totals = computeTotals(filtered);
  const ptax = options.ptax;

  const totalGrossBrl = totals.totalGrossUsd * ptax;
  const x402Brl = totals.x402GrossUsd * ptax;
  const integratorBrl = totals.integratorGrossUsd * ptax;
  const affiliateBrl = totals.affiliatePayoutsUsd * ptax;
  const netRevenueBrl = totals.netAfterAffiliateUsd * ptax;

  // Simples Nacional (Faixa 1 ilustrativa: Anexo III 6,00% vs Anexo V 15,50%)
  // Na exportação de serviços (PGDAS-D), PIS (3,49% / 2,76%), COFINS (12,85% / 14,10%)
  // e ISS (33,50% / 14,00%) são zerados da alíquota nominal.
  // Restam apenas IRPJ, CSLL e CPP (~47,96% da alíquota no Anexo III -> ~2,88% efetivo;
  // e ~69,14% da alíquota no Anexo V -> ~10,72% efetivo na 1ª faixa).
  const anexoIIIExportEffectiveRate = 0.0288;
  const anexoVExportEffectiveRate = 0.1072;

  const dasAnexoIIIBrl = netRevenueBrl * anexoIIIExportEffectiveRate;
  const dasAnexoVBrl = netRevenueBrl * anexoVExportEffectiveRate;
  const dasSavingsBrl = dasAnexoVBrl - dasAnexoIIIBrl;

  // Fator R: Pró-labore >= 28% da Receita Bruta (usando receita líquida de repasses
  // ou receita bruta conforme regime de caixa/competência e contrato de comissão).
  // Calculamos ambos para visibilidade do contador.
  const proLaboreMinGrossBrl = totalGrossBrl * 0.28;
  const proLaboreMinNetBrl = netRevenueBrl * 0.28;
  const proLaboreRecommendedBrl = netRevenueBrl * 0.285;
  const inssSeguradoEstimateBrl = Math.min(proLaboreRecommendedBrl * 0.11, 908.85);

  const periodLabel =
    options.month ??
    (filtered[0]?.timestamp ? filtered[0].timestamp.slice(0, 7) : "N/A");

  const lines: string[] = [
    "================================================================================",
    "  TAXRAIL — RELATÓRIO MENSAL DE EXPORTAÇÃO DE SERVIÇOS (SIMPLES NACIONAL)",
    "================================================================================",
    `  Competência      : ${periodLabel}`,
    `  Fonte do Ledger  : ${originLabel}`,
    `  Lançamentos      : ${filtered.length} (${totals.x402Count} x402 | ${totals.integratorCount} integrator_fees)`,
    `  Rede / Ativo     : Base (eip155:8453) / USDC`,
    `  PTAX Utilizada   : R$ ${ptax.toFixed(4)} / USD`,
    "",
    "1. CONSOLIDAÇÃO FINANCEIRA (USD -> BRL)",
    "--------------------------------------------------------------------------------",
    `  (+) Receita Bruta x402 (Upfront)      : ${formatUsd(totals.x402GrossUsd).padEnd(16)} | ${formatBrl(x402Brl)}`,
    `  (+) Integrator Fees (Swap Calldata)   : ${formatUsd(totals.integratorGrossUsd).padEnd(16)} | ${formatBrl(integratorBrl)}`,
    `  (=) Total Bruto Liquidado             : ${formatUsd(totals.totalGrossUsd).padEnd(16)} | ${formatBrl(totalGrossBrl)}`,
    `  (-) Repasse Afiliados (20% Devs/MCP)  : ${formatUsd(totals.affiliatePayoutsUsd).padEnd(16)} | ${formatBrl(affiliateBrl)}`,
    `  (=) Receita Líquida TaxRail (Net)     : ${formatUsd(totals.netAfterAffiliateUsd).padEnd(16)} | ${formatBrl(netRevenueBrl)}`,
    "",
    "2. SEGREGAÇÃO PGDAS-D (100% EXPORTAÇÃO DE SERVIÇOS)",
    "--------------------------------------------------------------------------------",
    `  Base Segregada (Exterior)             : ${formatBrl(netRevenueBrl)} (ou ${formatBrl(totalGrossBrl)} s/ dedução de comissão)`,
    "  Tributos Isentos na Exportação        : PIS (0,00%) | COFINS (0,00%) | ISS (0,00%)",
    "  Fundamento Legal                      : LC 116/2003 art. 2º, I; Lei 10.637/02;",
    "                                          Lei 10.833/03; Res. CGSN nº 140/2018.",
    "  [!] ALERTA CRÍTICO DE COMPLIANCE      : Para manter a isenção de ISS/PIS/COFINS,",
    "      é OBRIGATÓRIO o ingresso formal das divisas no Brasil via Contrato de",
    "      Câmbio emitido por instituição/rampa regulada autorizada pelo Banco Central.",
    "      Manter USDC on-chain sem fechamento formal de câmbio compromete o lastro",
    "      documental da exportação junto ao Fisco e à Prefeitura.",
    "",
    "3. OTIMIZAÇÃO FATOR R — PRÓ-LABORE 28% (ANEXO III vs ANEXO V)",
    "--------------------------------------------------------------------------------",
    `  Pró-labore 28% s/ Líquido             : ${formatBrl(proLaboreMinNetBrl)}`,
    `  Pró-labore 28% s/ Bruto               : ${formatBrl(proLaboreMinGrossBrl)}`,
    `  Pró-labore Recomendado (28,5% margem) : ${formatBrl(proLaboreRecommendedBrl)}`,
    `  INSS Retido Estimado (11%, c/ teto)   : ${formatBrl(inssSeguradoEstimateBrl)} (+ avaliar IRRF na fonte)`,
    "",
    "  Simulação DAS Exportação (1ª Faixa RBT12, sem PIS/COFINS/ISS):",
    `  - Anexo V  (~10,72% efetivo s/ exp.)  : ${formatBrl(dasAnexoVBrl)}`,
    `  - Anexo III (~2,88% efetivo s/ exp.)  : ${formatBrl(dasAnexoIIIBrl)}`,
    `  - Economia Fiscal Estimada c/ Fator R : ${formatBrl(dasSavingsBrl)} / mês`,
    "  (*) Valores ilustrativos de 1ª faixa. O contador deve recalcular com a",
    "      RBT12 acumulada e a folha de pagamento oficial dos últimos 12 meses.",
    "",
    "4. CHECKLIST MENSAL (NFS-e + INVOICE + CÂMBIO)",
    "--------------------------------------------------------------------------------",
    "  [ ] 1. Conciliar todos os tx hashes USDC na Base (eip155:8453) vs planIds.",
    "  [ ] 2. Separar comprovantes de split 20% para wallets afiliadas (evitar bitributação).",
    "  [ ] 3. Liquidar USDC em rampa/banco de câmbio regulado pelo BACEN e arquivar",
    "         o Contrato de Câmbio (SWIFT/fechamento) vinculado ao mês.",
    "  [ ] 4. Emitir Commercial Invoice em USD para os tomadores/protocolos no exterior.",
    "  [ ] 5. Emitir NFS-e de Exportação de Software/Serviços (CNAEs 6201/6202)",
    "         com indicação expressa de exportação para o exterior (ISS isento/não incidente).",
    "  [ ] 6. Confirmar pró-labore >= 28% da RBT12 para enquadramento no Anexo III.",
    "  [ ] 7. Enviar XML da NFS-e + Invoices + Contratos de Câmbio ao contador e",
    "         quitar DAS (PGDAS-D) e DARF previdenciário até o dia 20.",
    "================================================================================",
  ];

  return lines.join("\n");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const { entries, originLabel } = await loadEntries(options);
  console.log(renderReport(entries, originLabel, options));
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[export-revenue-ledger] Erro: ${message}`);
  process.exitCode = 1;
});
