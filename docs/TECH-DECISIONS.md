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

## 2. Precificação Dinâmica `MCP × x402` (10% da Economia) vs Taxa Fixa / SaaS

### Escolha Adotada
Modelo em **2 etapas**: descoberta gratuita (`check_tax_impact`, `compare_borrow_vs_sell`, `classify_deductible_expense`) seguida de desbloqueio (`unlock_tax_plan`) cobrando **10% da economia tributária verificada (`taxSavedUsd`)**, liquidado via **x402 (Base USDC `eip155:8453`)** com guardrail híbrido (`upfrontX402Usd` com teto de US$ 50 + `embeddedSwapFeeBps` de 0 a 100 bps + `enterpriseBalanceUsd`) e **20% de affiliate share** (`referrerWallet`).

### Comparativo Técnico

| Critério | `MCP × x402` Dinâmico (10% da economia) | Taxa Fixa por Chamada (ex.: US$ 0,10/call) | Assinatura SaaS Mensal (Cartão/Stripe) |
| :--- | :--- | :--- | :--- |
| **Alinhamento de Valor** | Cliente só paga quando há economia comprovada (`ROI > 1x`) | Cobra igual se economizou US$ 0 ou US$ 5.000 | Cobra mesmo sem uso |
| **Fricção para Agentes de IA** | Zero cadastro/cartão: agente paga via HTTP 402 com USDC na Base | Exige recarga prévia ou micro-cobrança constante | Inviável para agentes autônomos sem humano no checkout |
| **Ticket Médio / Upside** | Escala linearmente com o tamanho da operação (até o teto de bps) | Margem comprimida em operações grandes | Teto de ARPU previsível, porém difícil de vender para bots |
| **Complexidade de Implementação** | Exige proteção contra manipulação de `taxSavedUsd` e cap on-chain | Trivial | Exige billing portal, faturas e chargebacks |

### Prós e Contras na Prática
- **Prós:** Um agente não precisa pedir cartão de crédito corporativo ao fundador para testar o serviço. Ele simula grátis, vê que vai economizar US$ 800 de imposto usando HIFO/Aave em vez de FIFO, paga US$ 10 upfront via x402 e embute o restante no *calldata* do swap. Além disso, o split automático de 20% transforma desenvolvedores de *plugins* (AgentKit, LangChain, n8n) em canal de distribuição remunerado.
- **Contras:** A dependência do ecossistema x402 ainda está em maturação. Para reduzir atrito caso um protocolo ou tesouraria ainda não assine x402 nativamente, o modelo prevê `enterpriseBalanceUsd` para faturamento recorrente B2B.

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
