# Roadmap de Execução — TaxRail

Plano gradual em 4 fases para levar a **TaxRail** do monorepo local até uma infraestrutura de otimização fiscal autônoma para agentes de IA com receita recorrente em USDC na Base e conformidade fiscal no Brasil e nos EUA.

---

## Fase 0: Fundação & Testes Locais (Concluída / Atual)

**Objetivo:** Garantir precisão determinística do motor tributário, contratos de API tipados e esteira de validação contínua antes de colocar capital real em risco.

### Entregáveis
- [x] **Monorepo pnpm (`packages/shared`):** Tipos canônicos e schemas Zod para EUA (`INDIVIDUAL`, `LLC_PASS_THROUGH`, `C_CORP`) e Brasil (`PF_LEI_14754`, `PF_DOMESTIC`, `PJ_LUCRO_REAL`, `PJ_SIMPLES_EXPORT`).
- [x] **Motor Tributário (`packages/tax-engine`):** Simulação determinística FIFO vs HIFO/SpecID, Tax-Loss Harvesting, comparativo `compare_borrow_vs_sell` (Aave v3) e análise de despesas dedutíveis (`classify_deductible_expense`).
- [x] **Construtores Não-Custodiais (`packages/execution`):** Geração de `SwapIntentPayload` (`0x_v2`, `cow_swap`, `jupiter`), `AaveActionPayload` (`aave_v3`) e dossiês (`IRS_FORM_8949`, `QUICKBOOKS_EXPENSE`, `BR_LEI_14754`, `BR_LUCRO_REAL_OMIE_SPED`).
- [x] **Interfaces de Agente (`packages/mcp-cli` e `packages/agent-plugins`):** Servidor MCP stdio (`@taxrail/mcp`), plugin Coinbase AgentKit, tools LangChain e node declarativo n8n com suporte nativo a `referrerWallet`.
- [x] **Execução 1-Clique $0 Upfront (`prepare-execution` + `claim-dossier`):** Cobrança garantida de **10% da economia verificada** diretamente na própria operação via `0x v2` (até `1000 bps` com multi-recipient 80/20), `Jupiter` e `Aave v3` (`atomicBatchCalls` borrow + transfer), com verificação automática de recibo on-chain e liberação do CSV (`IRS Form 8949` / `BR Lei 14.754 / DeCripto`).
- [x] **Automação Financeira & CI:** Workflow `.github/workflows/ci.yml` (`typecheck`, `test`, `deploy:dry-run`) e script `scripts/export-revenue-ledger.ts` para consolidação PTAX / Simples Nacional (Fator R).

### Critério de Saída da Fase 0
`pnpm typecheck`, `pnpm test` e `pnpm deploy:dry-run` passando 100% em CI sem erros.

---

## Fase 1: Deploy Edge + Carteira Base + Primeiros Registros MCP / x402 Bazaar

**Objetivo:** Publicar a API de produção na Cloudflare Workers com liquidação real via x402 em USDC na Base (`eip155:8453`) e registrar a TaxRail nos primeiros diretórios de descoberta para agentes.

### Ações Principais
1. **Provisionamento de Tesouraria na Base (`eip155:8453`):**
   - Criar Safe Multisig (2-of-3) ou Smart Wallet dedicada na Base exclusivamente para recebimento de taxas `x402` e `integrator_fees`.
   - Configurar endereço de tesouraria nas variáveis de ambiente do Edge Worker (`apps/edge-worker`).
2. **Persistência Stateless de Planos (`planId`):**
   - Conectar Cloudflare KV / Durable Objects (ou Redis via HTTP) com TTL configurável para armazenar planos entre a Etapa 1 gratuita e a Etapa 2 (`unlock_tax_plan`).
3. **Deploy em Produção (`wrangler deploy`):**
   - Subir domínio `api.taxrail.online` com endpoints `/mcp` e `/api/v1/*`.
   - Validar fluxo completo HTTP `402 Payment Required` -> assinatura USDC na Base -> retorno do `FullTaxOptimizationPlan`.
4. **Publicação e Descoberta:**
   - Publicar pacotes `@taxrail/shared`, `@taxrail/mcp` e `@taxrail/agent-plugins` no npm.
   - Registrar endpoint MCP + x402 no **x402 Bazaar**, diretórios MCP oficiais e catálogos de ferramentas para agentes autônomos.

### Critério de Saída da Fase 1
Primeiras transações reais de `unlock_tax_plan` liquidadas on-chain na Base (`eip155:8453`) e conciliadas pelo `scripts/export-revenue-ledger.ts` com fechamento mensal de câmbio.

---

## Fase 2: Tração via Plugins + Programa de Afiliados 20% + Contadores BR / CPAs US

**Objetivo:** Transformar desenvolvedores de agentes, automações no-code e escritórios contábeis no principal motor de aquisição orgânica da TaxRail.

### Ações Principais
1. **Distribuição via Programa de Afiliados On-Chain (20%):**
   - Divulgar SDKs (`TaxRailActionProvider` para AgentKit, `createTaxRailLangChainTools` e node n8n) destacando o `referrerWallet` embutido, onde o dev ganha **20% da taxa da TaxRail** sem precisar de contratos manuais.
   - Criar *templates* prontos de agentes de tesouraria DAO, bots de rebalanceamento e fluxos n8n para PMEs.
2. **Parcerias com Contadores no Brasil (Lucro Real & Lei 14.754):**
   - Validar os formatos `BR_LEI_14754` e `BR_LUCRO_REAL_OMIE_SPED` junto a escritórios especializados em criptoativos e empresas de tecnologia.
   - Integrar exportação direta amigável para Omie / Conta Azul / SPED.
3. **Parcerias com CPAs nos Estados Unidos:**
   - Validar CSVs de `IRS_FORM_8949` e lançamentos `QUICKBOOKS_EXPENSE` com CPAs que atendem LLCs, C-Corps e fundadores com operação cripto/tesouraria.
4. **Telemetria de Economia Verificada:**
   - Painel público com volume otimizado e imposto economizado auditável (sem expor PII de carteiras).

### Critério de Saída da Fase 2
Base recorrente de integradores ativos com `referrerWallet` e parcerias piloto rodando com pelo menos 3 escritórios contábeis (BR/US).

---

## Fase 3: Camada Corporativa + Integração Opcional com Cartões Digitais & Rampas Reguladas

**Objetivo:** Capturar tesourarias corporativas e operações B2B de maior tíquete que ultrapassam o teto de *swap fees* ou exigem conciliação ponta a ponta entre cartões corporativos, cripto e câmbio regulado.

### Ações Principais
1. **Faturamento Enterprise (`PricingTier = "ENTERPRISE"`):**
   - Liquidação mensal automatizada do `enterpriseBalanceUsd` (excedente além do cap de US$ 50 upfront + 100 bps de swap) via invoice USDC ou fatura corporativa B2B.
   - Suporte a múltiplas carteiras e consolidação multi-entidade (holding US LLC + subsidiária BR).
2. **Integração Opcional com Cartões Digitais & Gestão de Despesas:**
   - Webhooks em tempo real para classificar gastos de cartões corporativos internacionais (`paidWithInternationalCard`) antes/durante o fechamento mensal, alimentando `classify_deductible_expense` e alertas de IOF / PIS / COFINS / IBS-CBS.
3. **Integração Opcional com Rampas Reguladas (Brasil & EUA):**
   - Conectores opcionais (sem custódia pela TaxRail) para acionar *off-ramps* licenciadas pelo Banco Central no Brasil com emissão automática de Contrato de Câmbio para ingresso formal de divisas, e *ramps* reguladas nos EUA.
   - Automação do vínculo `txHash -> Invoice -> Contrato de Câmbio -> NFS-e` para fechar a contabilidade da própria operação ou de clientes PJ exportadores.

### Critério de Saída da Fase 3
Contas Enterprise ativas utilizando roteamento fiscal pré-trade + conciliação de despesas e geração automatizada de dossiês contábeis prontos para auditoria.
