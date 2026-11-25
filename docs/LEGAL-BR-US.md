# Guia Prático de Compliance — Brasil & EUA

> **Aviso:** Este documento tem caráter informativo e operacional para estruturar a operação da TaxRail como empresa de software no Brasil vendendo para o mercado global. Ele **não substitui** parecer jurídico ou acompanhamento contínuo de um advogado tributarista/societário e de um contador habilitado (CRC no Brasil / CPA nos EUA).

---

## 1. Posicionamento Estrito como Software de Cálculo e Roteamento

A primeira linha de defesa regulatória da TaxRail — tanto perante o Fisco/CVM no Brasil quanto perante o IRS/SEC/FinCEN nos EUA — é **o que o produto é e o que ele nunca faz**:

### O que a TaxRail É
- **Software B2B / Infraestrutura de Cálculo Determinístico:** Aplica regras matemáticas públicas (FIFO vs HIFO, cálculo de LTV, alíquotas informadas pelo próprio usuário/agente) para simular cenários e formatar dados pré-contábeis.
- **Gerador de Payloads Não-Custodiais:** Constrói *intents* e *calldata* (`0x_v2`, `cow_swap`, `jupiter`, `aave_v3`) sem assinar, transmitir ou custodiar ativos.

### O que a TaxRail NÃO Faz
1. **Sem exercício ilegal de consultoria tributária / advocacia:** Não emite parecer jurídico vinculante nem assina declarações fiscais em nome de terceiros. Toda resposta da API/MCP inclui `disclaimer` explícito exigindo revisão por contador (BR) ou CPA (US).
2. **Sem atuação regulada pela CVM (Valores Mobiliários):** Não faz recomendação de compra/venda de ativos financeiros, gestão de carteira discricionária ou oferta pública de investimento. O agente ou usuário já decidiu o ativo/liquidez desejada; o software apenas calcula impacto tributário e monta o *calldata* técnico solicitado.
3. **Sem custódia ou intermediação financeira (VASP / Instituição de Pagamento):** A TaxRail não recebe depósitos de clientes para repassar a terceiros, não guarda chaves privadas e não opera livro de ofertas. Os pagamentos `x402` são exclusivamente remuneração pelo licenciamento/uso da API de software.

---

## 2. Operação via CNPJ no Brasil — Exportador de Serviços de Software

Operar a TaxRail a partir de uma PJ brasileira (LTDA / SLU) faturando em dólar (USDC na Base liquidado via rampa regulada) permite usufruir do regime de **Exportação de Serviços**, desde que o fluxo societário, fiscal e cambial seja seguido à risca.

### 2.1. Enquadramento Societário e CNAEs
Para licenciamento/desenvolvimento de software e APIs SaaS/infraestrutura:
- **6201-5/01** — Desenvolvimento de programas de computador sob encomenda
- **6202-3/00** — Desenvolvimento e licenciamento de programas de computador customizáveis
- **6203-1/00** — Desenvolvimento e licenciamento de programas de computador não-customizáveis
- **6209-1/00** — Suporte técnico, manutenção e outros serviços em tecnologia da informação

> **Atenção:** Evite CNAEs de "consultoria tributária/contábil" ou "intermediação financeira" no objeto social da empresa de software, pois podem conflitar com conselhos de classe (CRC/OAB) ou impedir o Simples Nacional.

### 2.2. Simples Nacional e Otimização pelo Fator R (28%)
Atividades de desenvolvimento/licenciamento de software (CNAEs 6201/6202) são tributadas originalmente no **Anexo V** do Simples Nacional (alíquota nominal inicial de **15,50%**), mas podem migrar para o **Anexo III** (alíquota nominal inicial de **6,00%**) quando o **Fator R >= 28%**:

$$\text{Fator R} = \frac{\text{Folha de Salários + Pró-labore + Encargos (últimos 12 meses)}}{\text{Receita Bruta Total (RBT12 — últimos 12 meses)}} \ge 0{,}28$$

- **Prática recomendada:** Manter o pró-labore dos sócios (com INSS devidamente recolhido) em torno de **28,5% da receita mensal/RBT12** para ter margem de segurança contra variações cambiais (PTAX) que poderiam derrubar o índice para 27,9% e jogar toda a competência de volta para o Anexo V.
- Utilize `scripts/export-revenue-ledger.ts` mensalmente para calcular o alvo de pró-labore em BRL antes do fechamento da folha.

### 2.3. Segregação PGDAS-D — Isenção de PIS, COFINS e ISS
Quando uma empresa brasileira exporta serviços de software/API para tomadores residentes ou domiciliados no exterior e o **resultado do serviço se verifica no exterior**, aplicam-se as seguintes regras no PGDAS-D:
- **PIS e COFINS (0%):** Isenção na exportação de serviços com ingresso de divisas (Lei nº 10.637/2002 art. 5º, II; Lei nº 10.833/2003 art. 6º, II; Resolução CGSN nº 140/2018).
- **ISS (0%):** Não incidência sobre exportação de serviços para o exterior cujo resultado lá se verifique (LC nº 116/2003 art. 2º, I).
- **Tributos devidos no DAS:** Permanecem apenas **IRPJ, CSLL e CPP** (reduzindo a carga efetiva da 1ª faixa do Anexo III de ~6,00% para cerca de ~2,88%, além de INSS/IRRF sobre o pró-labore).

### 2.4. Regra de Ouro: Ingresso Formal de Divisas e Contrato de Câmbio
**Ponto crítico que mais gera autuação fiscal em empresas cripto/Web3 no Brasil:**

Receber USDC na carteira da empresa na Base (`eip155:8453`) e deixá-lo indefinidamente em autocustódia ou gastar diretamente via cartão cripto offshore **pode descaracterizar a isenção de PIS/COFINS/ISS** na exportação de serviços.

Para blindar a segregação no PGDAS-D, o fluxo mensal deve obedecer a esta trilha documental:
1. **Consolidação On-Chain:** Exportar os recebimentos `x402` e `integrator_fees` do mês (`txHash`, `planId`, data UTC, valor líquido após split de 20% para afiliados).
2. **Liquidação via Rampa Regulada (BACEN):** Transferir o USDC da carteira tesouraria PJ para uma corretora/instituição ou banco de câmbio autorizado pelo Banco Central do Brasil que emita **Contrato de Câmbio** formal (ou operação de câmbio vinculada a exportação de serviços, conforme natureza cambial indicada pelo contador).
3. **Invoice + NFS-e de Exportação:** Emitir *Commercial Invoice* em USD e a respectiva **NFS-e de Exportação** na prefeitura sede do CNPJ, vinculando os valores convertidos pela taxa cambial oficial.
4. **Repasse de Afiliados (20%):** Como o `affiliateShareUsd` (20%) é direcionado a terceiros desenvolvedores (`referrerWallet`), alinhe com o contador se o split ocorre diretamente no contrato/roteador (não transitando como receita da TaxRail) ou se há repasse documentado — isso evita pagar imposto brasileiro sobre a parcela que pertence ao desenvolvedor parceiro.

### 2.5. Reforma Tributária (IBS / CBS)
Embora a transição do IBS/CBS comece gradualmente a partir de 2026, a TaxRail já modela `ibsCbsReadinessCreditUsd` no endpoint `classify_deductible_expense` para empresas no Lucro Real, mantendo o princípio constitucional da **não incidência/imunidade nas exportações** na operação própria da TaxRail.

---

## 3. Cuidados nos Estados Unidos (IRS Form 1099-DA & CPA)

Ao atender usuários, LLCs, C-Corps e agentes operando sob jurisdição dos EUA (`jurisdiction = "US"`):

### 3.1. Contexto do IRS Form 1099-DA (Digital Asset Brokers)
As regras finais do Tesouro/IRS sobre o **Form 1099-DA** exigem que *custodial brokers* (corretoras centralizadas, processadores de pagamento custodiais) reportem receitas brutas e, progressivamente, *cost basis* de transações com ativos digitais.

- **Por que a TaxRail não é um *Broker* tradicional:** A TaxRail **não** efetua custódia, **não** intermedia ordens em nome próprio e **não** executa a liquidação dos swaps do cliente — apenas gera *calldata* não-custodial e simulações fiscais com base nos lotes (`TaxLot[]`) informados pelo próprio usuário/agente.
- **Risco a monitorar:** Caso, em fases futuras (Fase 3), a TaxRail passe a operar roteamento próprio com custódia temporária ou liquidação fiduciária direta em USD para clientes dos EUA, será obrigatória análise jurídica prévia nos EUA (FinCEN/IRS) para avaliar obrigações de KYC e Form 1099-DA. Até lá, manter a camada de execução estritamente **não-custodial**.

### 3.2. Limites de Atuação sob o Circular 230 / CPA
Nos EUA, a preparação remunerada de declarações fiscais (*tax return preparation*) e a representação perante o IRS são reguladas (IRS Circular 230 / PTIN / CPA / EA / Tax Attorney):
- Os dossiês `IRS_FORM_8949` e `QUICKBOOKS_EXPENSE` devem ser apresentados explicitamente como **relatórios auxiliares de cálculo e exportação contábil** (*pre-accounting data exports*).
- Todo output da TaxRail deve preservar o `disclaimer` padrão informando que o usuário deve validar a eleição de *Specific Identification (SpecID)*, regras de *Wash Sale* (caso aplicáveis) e dedutibilidade de despesas com um **CPA ou Tax Attorney licenciado** antes do envio ao IRS.

### 3.3. Contratos e Termos de Uso (ToS)
Antes de abrir tráfego público pago na Fase 1, os Termos de Serviço em `api.taxrail.online` devem deixar claros:
1. Ausência de relação fiduciária ou de assessoria jurídica/fiscal/financeira;
2. Responsabilidade exclusiva do usuário/operador do agente pela assinatura das transações on-chain, verificação de slippage/LTV na Aave v3 e conferência da veracidade dos lotes (`costBasisUsd`, `acquiredAt`);
3. Limitação de responsabilidade limitada às taxas efetivamente pagas à TaxRail na respectiva transação.
