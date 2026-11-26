# Decisões Técnicas de Arquitetura (Visão de CTO)

Este documento registra os *trade-offs* arquiteturais da **TaxRail**, comparando alternativas avaliadas e justificando o desenho adotado no monorepo.

---

## 1. Runtime Edge (`Cloudflare Workers + Hono`) vs `Node.js / Railway` vs `Vercel Serverless`

### Escolha Adotada
**Cloudflare Workers** com **Hono** (`@modelcontextprotocol/hono` + `@x402/hono`) em `apps/edge-worker`.

### Comparativo Técnico

| Critério | Cloudflare Workers + Hono | Node.js (Railway / Fly.io) | Vercel Serverless / Functions |
| :--- | :--- | :--- | :--- |
| **Cold Start** | ~0–5 ms (V8 Isolates globais) | 300 ms–2 s (container wake / scaling) | 150 ms–800 ms (Node micro-VM) |
| **Latência Global** | Execução na borda (300+ PoPs) | Região única ou multi-região cara | Limitado às regiões escolhidas |
| **Custo p/ Tráfego de Agentes** | Altamente elástico (pay-per-request / CPU ms) | Custo fixo por instância 24/7 | Custo por GB-hora e invocações mais alto em escala |
| **Integração MCP + x402** | Hono nativo, leve (~14 KB), middleware `@x402/hono` direto | Precisa gerenciar servidor HTTP, proxy e TLS | Bom suporte Next/Node, mas menos enxuto para MCP puro |
| **Restrições de Runtime** | Sem filesystem local, limite de CPU por request, Web APIs | Acesso completo a OS, sockets e filesystem | Limite de timeout e bundle |

### Prós e Contras na Prática
- **Prós:** Agentes autônomos fazem dezenas de simulações gratuitas (`check_tax_impact`) antes de executar um único swap. Em V8 Isolates com custo próximo de zero por milissegundo de CPU, podemos oferecer a Etapa 1 gratuita sem destruir a margem.
- **Contras:** Não há filesystem nem estado persistente em memória entre *isolates* distintos. Por isso, o cache/armazenamento de `planId` em produção precisa migrar de memória local para **Cloudflare KV / Durable Objects** ou **Upstash Redis**, mantendo o worker *stateless*.
- **Quando reavaliar:** Se precisarmos de bibliotecas nativas C++/Python para processamento pesado de extratos bancários em PDF/OCR ou filas longas de conciliação (>30s), moveremos apenas o *worker* assíncrono de ingestão para Node.js/Railway, mantendo o *rail* síncrono de pré-execução na Cloudflare.

---

## 2. Precificação Orientada a Resultado: 10% Pagos Pela Própria Operação ($0 Upfront) + Fallback `x402`

### Escolha Adotada
Modelo **1-Clique com $0 Upfront**: descoberta gratuita (`check_tax_impact`, `compare_borrow_vs_sell`, `classify_deductible_expense`) seguida de `POST /api/v1/prepare-execution` (gratuito), onde **exatamente 10% da economia tributária verificada (`taxSavedUsd`)** é cobrado **diretamente do resultado da própria operação** — via `0x v2` / `Jupiter` (`embeddedSwapFeeBps` / `embeddedSwapFeePpm` até `1000 bps` = 10%, com split nativo multi-recipient 80/20) ou via `Aave v3` (`totalBorrowAmountUsd = liquidityNeededUsd + 10% fee` em `atomicBatchCalls`). Após a confirmação on-chain, `POST /api/v1/claim-dossier` verifica o `txHash` via RPC e libera os lotes SpecID e o CSV (`IRS Form 8949` / `BR Lei 14.754 / DeCripto`). O fluxo `x402` (`/api/v1/unlock-plan`) permanece ativo como fallback para despesas corporativas off-chain (`classify_deductible_expense`) e agentes nativos x402.

### Comparativo Técnico

| Critério | $0 Upfront (10% na Operação) | `x402` Antecipado Obrigatório | Assinatura SaaS Mensal |
| :--- | :--- | :--- | :--- |
| **Atrito de Checkout** | **Zero:** humano ou agente paga na rede em que já está, sem saldo prévio em Base USDC | Exige USDC na Base antes da operação | Exige cartão e cadastro |
| **Garantia de 10% da Economia** | `0x v2` (até 1000 bps), `Jupiter` (até 100%) e `Aave v3` (borrow + transfer) cobrem 100% da taxa | Guardrail de US$ 50 exigia cobrança Enterprise no excedente | Teto fixo de ARPU |
| **Anti-Bypass** | Dossiê SpecID / Form 8949 / DeCripto só é liberado após verificação on-chain do recebimento da taxa | Libera após assinatura EIP-3009 x402 | Sem vínculo com a execução on-chain |

### Prós e Contras na Prática
- **Prós:** Um trader nos EUA (1099-DA / TLH até 31/12) ou no Brasil (DeCripto / Lei 14.754) ou um agente de IA executa a operação em 1 clique pagando **US$ 0 do próprio bolso antecipadamente**. Como a `0x v2` na Ethereum/Base/Arbitrum permite até `1000 bps` (10%) sem reter corte de protocolo (ao contrário do `CoW Swap`, que limitava em 100 bps e retinha 25%), roteamos todo EVM pela `0x v2` e garantimos exatamente 10% da economia.
- **Contras:** Requer verificação on-chain (`eth_getTransactionReceipt`) no endpoint `/api/v1/claim-dossier` para confirmar a entrega da taxa à tesouraria antes de liberar o CSV auditável. Mitigamos isso usando Alchemy RPC com fallback público em < 500 ms.

---

## 3. Motor Tributário Determinístico vs LLM

### Escolha Adotada
**Motor 100% determinístico** em TypeScript puro (`@taxrail/tax-engine`) validado por Zod (`@taxrail/shared`), deixando o LLM apenas na camada de orquestração conversacional do cliente/agente.

### Comparativo Técnico

| Critério | Motor Determinístico (TypeScript + Zod) | Cálculo via LLM (Prompting / Tool-less) |
| :--- | :--- | :--- |
| **Precisão Aritmética** | 100% exata, auditável e reproduzível (`asOfDate`) | Propenso a erros de arredondamento, seleção errada de lotes e alucinação de alíquotas |
| **Auditabilidade Fiscal** | Cada linha do `IRS_FORM_8949` ou `BR_LEI_14754` tem trilha matemática | Caixa-preta probabilística, inaceitável para contador ou CPA |
| **Latência e Custo** | < 5 ms em Edge Worker, custo de inferência R$ 0,00 | 1–5 segundos + custo de tokens a cada simulação |
| **Manutenção Regulatória** | Regras versionadas em tabelas e testes unitários no Vitest | Mudanças de prompt quebram casos de borda silenciosamente |

### Prós e Contras na Prática
- **Prós:** Em matéria tributária (Lei 14.754, isenção mensal de R$ 35 mil no Brasil, NIIT de 3,8% e distinção *short-term* vs *long-term* nos EUA), um único erro de cálculo invalida toda a confiança no produto. O motor determinístico garante que o mesmo input sempre produz o mesmo `taxSavedUsd`.
- **Contras:** Exige manutenção explícita de código quando há mudança legislativa (ex.: transição IBS/CBS no Brasil ou novas regras de custódia/1099-DA nos EUA). Mitigamos isso isolando regras por jurisdição e regime com suíte de testes automatizados.

---

## 4. Arquitetura Não-Custodial (`viem` / Calldata + 0x v2 / CoW / Jupiter / Aave v3) vs Custódia Própria

### Escolha Adotada
**Arquitetura estritamente não-custodial** (`@taxrail/execution`): a TaxRail gera `SwapIntentPayload` (templates para `0x_v2`, `cow_swap`, `jupiter`) e `AaveActionPayload` (`aave_v3` supply/borrow calldata) com `feeRecipients` explícitos, mas **nunca** recebe chaves privadas nem custodia fundos do usuário.

### Comparativo Técnico

| Critério | Não-Custodial (Calldata + Aggregators) | Custodial (Smart Vault / Custódia Própria) |
| :--- | :--- | :--- |
| **Risco Regulatório (BR/US)** | Mínimo: atua como software de roteamento e cálculo | Altíssimo: exige licenças de VASP / Money Transmitter / Instituição de Pagamento |
| **Risco de Segurança / Hack** | Zero TVL custodiado pela TaxRail | Alvo direto de ataques ao cofre centralizado |
| **Experiência do Usuário/Agente** | Agente assina com sua própria wallet (EOA, Safe, Smart Wallet) | Usuário precisa depositar antes de operar |
| **Controle de Execução** | Depende da disponibilidade e formato de API dos agregadores | Controle total, mas com responsabilidade fiduciária |

### Prós e Contras na Prática
- **Prós:** Permite operar globalmente a partir de um CNPJ brasileiro de software sem assumir risco fiduciário de custódia de ativos de terceiros, mantendo transparência total das taxas de integrador (`integratorFeeBps`) direto na transação on-chain.
- **Contras:** A execução depende da integração final na carteira/agente do usuário e das políticas dos agregadores (0x, CoW, Jupiter). Por isso entregamos `requestTemplate` padronizado e plugins prontos (`@taxrail/agent-plugins`) para encurtar a integração para < 10 linhas de código.
