# FERRAMENTAS.md — Catálogo Completo das 33 Ferramentas

Referência de todas as ferramentas expostas pelo **OpLab MCP Server**, agrupadas por
finalidade. Cada entrada descreve **o que faz**, os **parâmetros** (obrigatórios em
**negrito**) e um **exemplo de uso**.

- **29 ferramentas simples** (`build`): mapeiam 1:1 para um `GET` da API REST da OpLab v3.
- **4 ferramentas compostas** (`handler`): fazem cálculos/múltiplas chamadas/cache —
  a lógica vive em `src/utils/` (ver [INDEX.md](INDEX.md)).

> Convenção de risco: as ferramentas 32 e 33 são **analíticas** — apenas simulam/sugerem,
> **nunca enviam ordens** ao mercado.

Índice:
1. [Taxas de juros](#1-taxas-de-juros)
2. [Opções](#2-opções)
3. [Cotação](#3-cotação)
4. [Instrumentos](#4-instrumentos)
5. [Status de mercado](#5-status-de-mercado)
6. [Companhias](#6-companhias)
7. [Ações](#7-ações)
8. [Estatísticas em tempo real](#8-estatísticas-em-tempo-real)
9. [Rankings](#9-rankings)
10. [Histórico](#10-histórico)
11. [Bolsas](#11-bolsas)
12. [IV Rank — volatilidade implícita (composta)](#12-iv-rank--volatilidade-implícita-composta)
13. [Backtesting — Protocolo 2 (composta)](#13-backtesting--protocolo-2-composta)
14. [Plano mensal de travas (composta)](#14-plano-mensal-de-travas-composta)

---

## 1. Taxas de juros

### `get_interest_rates`
Lista todas as taxas de juros disponíveis (SELIC, CDI, CETIP, etc.).
- **Parâmetros:** nenhum.
- **Exemplo:** `get_interest_rates()`

### `get_interest_rate`
Consulta uma taxa de juros específica pela sigla.
- **Parâmetros:** **`id`** (string — ex: `SELIC`, `CDI`).
- **Exemplo:** `get_interest_rate(id="SELIC")`

---

## 2. Opções

### `get_instrument_options`
Lista toda a cadeia de opções (calls e puts) de uma ação, com prêmios, strikes e vencimentos.
- **Parâmetros:** **`symbol`** (string — ex: `PETR4`).
- **Exemplo:** `get_instrument_options(symbol="VALE3")`
- ⚠️ Payload grande (~MB) e **sem gregas/IV** — para delta/bid/ask use `get_instrument_series` com `bs=true`.

### `get_option`
Detalhes de uma opção específica: prêmio, strike, vencimento, gregas (delta, gamma, theta, vega) e IV.
- **Parâmetros:** **`symbol`** (string — código da opção, ex: `PETRH245`).
- **Exemplo:** `get_option(symbol="PETRH245")`

### `get_covered_options`
Opções recomendadas para estratégias cobertas (covered call / cash-secured put).
- **Parâmetros:** `underlying` (string — códigos separados por vírgula, opcional).
- **Exemplo:** `get_covered_options(underlying="PETR4,VALE3")`

### `get_options_bs`
Calcula Black-Scholes de uma opção: prêmio teórico, gregas e IV a partir dos parâmetros.
- **Parâmetros:** **`symbol`**, **`irate`** (taxa de juros %); opcionais: `type`, `spotprice`, `strike`, `premium`, `dtm`, `vol`, `duedate`, `amount`.
- **Exemplo:** `get_options_bs(symbol="PETRH245", irate=10.75)`

### `get_options_powders`
Lista os principais "pozinhos" (opções baratas de alto potencial de ganho).
- **Parâmetros:** nenhum.
- **Exemplo:** `get_options_powders()`

---

## 3. Cotação

### `get_quote`
Cotações em tempo real de uma lista de instrumentos (ações, opções, índices).
- **Parâmetros:** **`tickers`** (string — separados por vírgula).
- **Exemplo:** `get_quote(tickers="PETR4,VALE3,PETRH245")`

---

## 4. Instrumentos

### `search_instruments`
Pesquisa instrumentos por código ou nome (busca parcial), com filtros por tipo.
- **Parâmetros:** **`expr`** (termos); opcionais: `limit`, `type`, `has_options`, `category`, `add_info`.
- **Exemplo:** `search_instruments(expr="PETR", has_options=true)`

### `get_instrument_series`
Lista as séries de opções (vencimentos) de um instrumento, opcionalmente com Black-Scholes.
- **Parâmetros:** **`symbol`**; opcionais: `bs` (boolean), `irate` (necessário se `bs=true`).
- **Exemplo:** `get_instrument_series(symbol="VALE3", bs=true, irate=14.9)`
- 💡 Com `bs=true`, cada opção traz `bid`, `ask` e gregas em `put.bs.delta`/`call.bs.delta` — é a fonte de delta+bid/ask ao vivo usada pela ferramenta 33.

### `get_instrument`
Detalhes de um instrumento específico (ação, opção, índice, FII, etc.).
- **Parâmetros:** **`symbol`**.
- **Exemplo:** `get_instrument(symbol="IBOV")`

### `get_instruments_detail`
Detalhes de múltiplos instrumentos em uma única chamada.
- **Parâmetros:** **`tickers`** (string — separados por vírgula).
- **Exemplo:** `get_instruments_detail(tickers="PETR4,VALE3,ITUB4")`

---

## 5. Status de mercado

### `get_market_status`
Status atual do mercado (aberto, fechado, pré-abertura, leilão, etc.). Usado também como verificação de saúde da API.
- **Parâmetros:** nenhum.
- **Exemplo:** `get_market_status()`

---

## 6. Companhias

### `get_companies`
Dados de múltiplas companhias com seleção granular de atributos: fundamentalistas (DRE, BPA, BPP, DFC), dividendos, setor e indicadores técnicos (m9_m21, iv_current, oplab_score, etc.).
- **Parâmetros:** **`symbols`**; opcional: `includes` (atributos separados por vírgula).
- **Exemplo:** `get_companies(symbols="VALE3,PETR4", includes="close,m9_m21,iv_current")`

---

## 7. Ações

### `get_stocks`
Lista ações que possuem opções listadas na B3, com ordenação e filtro por volume financeiro.
- **Parâmetros:** opcionais — `rank_by`, `sort`, `limit`, `financial_volume_start`.
- **Exemplo:** `get_stocks(rank_by="oplab_score", sort="desc", limit=20)`

### `get_stocks_all`
Lista todas as ações da B3 com paginação e ordenação.
- **Parâmetros:** opcionais — `page`, `per`, `rank_by`, `sort`, `financial_volume_start`.
- **Exemplo:** `get_stocks_all(page=1, per=50)`

### `get_stock`
Dados de uma ação: preço, OHLC, volume, variação, volatilidade, gregas, `m9_m21`, `iv_current` e opcionalmente fundamentalistas.
- **Parâmetros:** **`symbol`**; opcional: `with_financials`.
- **Exemplo:** `get_stock(symbol="VALE3")`

---

## 8. Estatísticas em tempo real

### `get_highest_options_volume`
Ações com os maiores volumes em opções (call, put ou total) em tempo real.
- **Parâmetros:** opcionais — `order_by` (`call`/`put`/`total`), `limit`.
- **Exemplo:** `get_highest_options_volume(order_by="put", limit=20)`

### `get_best_covered_options_rates`
Opções com as maiores taxas de retorno para estratégias cobertas.
- **Parâmetros:** **`type`** (`CALL`/`PUT`); opcional: `limit`.
- **Exemplo:** `get_best_covered_options_rates(type="PUT", limit=20)`

### `get_highest_options_variation`
Opções com as maiores variações de preço (calls ou puts) em tempo real.
- **Parâmetros:** **`type`** (`CALL`/`PUT`); opcional: `limit`.
- **Exemplo:** `get_highest_options_variation(type="CALL")`

---

## 9. Rankings

### `get_m9m21_ranking`
Ações ranqueadas pela tendência M9/M21 (médias móveis de 9 e 21 dias). `sort=asc` = tendência de alta.
- **Parâmetros:** opcionais — `sort`, `limit`, `financial_volume_start`, `days`.
- **Exemplo:** `get_m9m21_ranking(sort="asc", limit=20)`

### `get_correl_ibov_ranking`
Ações ordenadas pela correlação com o IBOVESPA.
- **Parâmetros:** opcionais — `sort`, `limit`, `financial_volume_start`, `days`.
- **Exemplo:** `get_correl_ibov_ranking(sort="asc")`

### `get_companies_ranking`
Companhias ordenadas por um atributo fundamentalista (ROE, ROIC, EV/EBIT, Magic Formula, P/L, margens, etc.).
- **Parâmetros:** **`attribute`**; opcionais: `group_by`, `sort`, `limit`, `financial_volume_start`.
- **Exemplo:** `get_companies_ranking(attribute="roe", sort="desc")`

### `get_oplab_score_ranking`
Ações ordenadas pelo OpLab Score (indicador proprietário de qualidade).
- **Parâmetros:** opcionais — `score_start`, `financial_volume_start`, `group_by`, `sort`, `limit`.
- **Exemplo:** `get_oplab_score_ranking(score_start=70)`

---

## 10. Histórico

### `get_historical_data`
Série histórica de preços (OHLCV) com resolução configurável (1h, 1d, 1w, 1m, 1y).
- **Parâmetros:** **`symbol`**, **`resolution`**, **`from`**, **`to`**; opcionais: `amount`, `raw`, `smooth`, `df`.
- **Exemplo:** `get_historical_data(symbol="VALE3", resolution="1d", from="2025-01-01", to="2025-12-31")`

### `get_historical_options`
Histórico da cadeia de opções de um ativo num intervalo (snapshot diário com gregas, delta, prêmio, DTE).
- **Parâmetros:** **`spot`**, **`from`**, **`to`**; opcional: `symbol`.
- **Exemplo:** `get_historical_options(spot="VALE3", from="2025-01-15", to="2025-01-15")`
- 💡 Tem `delta`, `premium`, `days_to_maturity`, `strike`, `due_date` por opção — é a fonte de dados do backtest (ferramenta 32).

### `get_historical_instruments`
Dados de múltiplos instrumentos numa data específica (snapshot histórico OHLCV).
- **Parâmetros:** **`tickers`**, **`date`**.
- **Exemplo:** `get_historical_instruments(tickers="PETR4,VALE3", date="2025-06-30")`

---

## 11. Bolsas

### `get_exchanges`
Lista todas as bolsas de valores disponíveis na plataforma.
- **Parâmetros:** nenhum.
- **Exemplo:** `get_exchanges()`

### `get_exchange`
Detalhes de uma bolsa pelo UID.
- **Parâmetros:** **`uid`** (ex: `BVMF`).
- **Exemplo:** `get_exchange(uid="BVMF")`

---

## 12. IV Rank — volatilidade implícita (composta)

> Lógica em `src/utils/iv_calculator.ts`. Cache em memória de **4h**; processamento em
> **lotes de 3 com 300ms** entre lotes (evita HTTP 429).

### `get_iv_rank_historico`
Calcula IV Rank e IV Percentile de **um** ativo, comparando a IV atual (`iv_current`) com a faixa histórica de volatilidade realizada de 21 dias (anualizada). Retorna classificação operacional, multi-período, consenso, alerta de evento e histórico mensal.
- **Parâmetros:** **`ticker`**; opcional: `periodo` (21, 63, 126 ou 252 — padrão 252).
- **Exemplo:** `get_iv_rank_historico(ticker="VALE3", periodo=252)`
- **Campos-chave do retorno:**
  - `iv_rank`, `iv_percentile`, `classificacao` (MUITO_ALTA/ALTA/MEDIA/BAIXA), `sinal_operacional`.
  - `historico_insuficiente` / `dias_disponiveis` / `aviso` — ativos com `< 126` dias úteis recebem `classificacao: "INSUFICIENTE"`.
  - `multi_periodo` — IV Rank nas 4 janelas (21/63/126/252d) sem chamadas extras.
  - `consenso` / `consenso_sinal` / `consenso_confianca` — cruzando 63d×126d (`DIVERGENTE` quando discordam).
  - `alerta_evento` / `alerta_evento_msg` — quando `iv_atual > 2× iv_media_periodo`.

**Como o IV Rank é calculado:** retornos logarítmicos → volatilidade rolling 21d anualizada (`std × √252 × 100`) → `IV Rank = (iv_atual − min) / (max − min) × 100`. Fonte da IV atual: `iv_current` de `/market/stocks` (`iv_fonte: "implicita"`); fallback para vol. realizada recente (`iv_fonte: "historica"`).

### `get_iv_rank_bulk`
IV Rank de **vários** ativos de uma vez, ranqueados por IV Rank decrescente, com triagem automática.
- **Parâmetros:** opcionais — `tickers` (lista; padrão = whitelist de 24 ativos), `periodo`.
- **Exemplo:** `get_iv_rank_bulk()` ou `get_iv_rank_bulk(tickers=["VALE3","PETR4"])`
- **Campos-chave:** `ranking[]` (ordenado), `resumo` (contagem por classificação), `cache_hits`/`api_calls`, e **`triagem`** com `prontos_para_operar` / `verificar_antes` / `descartar`.

---

## 13. Backtesting — Protocolo 2 (composta)

> Lógica em `src/utils/backtest_engine.ts`. **Analítica — apenas simula.** Cache de **24h**;
> lotes de 3 com 500ms; timeout de 10s/ativo; período máximo de 2 anos.

### `get_backtest_protocolo2`
Backtesting histórico da venda de PUTs OTM. Para cada dia útil aplica filtros (IV Rank, M9/M21), seleciona a PUT candidata e simula o resultado no vencimento. Pode simular PUT a descoberto (padrão) ou trava Bull Put Spread.
- **Parâmetros (todos opcionais):**
  - `tickers` (padrão = whitelist de 24), `data_inicio`, `data_fim` (padrão = 2 anos).
  - `delta_min` (-0.30), `delta_max` (-0.15), `dte_min` (15), `dte_max` (30), `iv_rank_min` (50), `m9m21_filter` (true).
  - `use_spread` (false) — se `true`, simula **Bull Put Spread** (perda limitada).
  - `spread_width` (3.0) — largura da trava em R$ (só com `use_spread=true`).
- **Exemplos:**
  ```
  get_backtest_protocolo2(tickers=["VALE3"], data_inicio="2025-01-01", data_fim="2025-03-31")
  get_backtest_protocolo2(tickers=["VALE3"], use_spread=true, spread_width=3.00)
  get_backtest_protocolo2()        # completo: 24 ativos, 2 anos
  ```
- **Campos-chave:** `resumo_geral` (win_rate, P&L, sequências), **`comparativo_filtros`** (com/sem cada filtro — prova estatística, sempre calculado), `por_ativo`, `por_mes`, `curva_capital`, `alertas`.
- **Estruturas:** `NAKED_PUT` (ganho = prêmio; perda grande) vs `BULL_PUT_SPREAD` (ganho = crédito líquido; **perda máx = `(largura − crédito) × 100`**).

---

## 14. Plano mensal de travas (composta)

> Lógica em `src/utils/opportunity_engine.ts`. **Analítica — apenas sugere.** Lotes de 3 com 300ms.

### `get_oportunidades_mensais`
Monta um plano mensal de travas Bull Put Spread que, combinadas, buscam atingir a meta de prêmio líquido do mês respeitando capital e margem. Aplica filtros de qualidade, seleciona a trava real da cadeia ao vivo e dimensiona os lotes.
- **Parâmetros:** **`capital`** (R$); opcionais — `meta_mensal` (4000), `margem_max_pct` (0.35), `spread_width` (3.0), `delta_min` (-0.25), `delta_max` (-0.15), `dte_min` (15), `dte_max` (30), `iv_rank_periodo` (63 — janela do IV Rank: 21/63/126/252), `tickers` (padrão = 12 ativos pré-selecionados).
- **Exemplos:**
  ```
  get_oportunidades_mensais(capital=130000)
  get_oportunidades_mensais(capital=130000, meta_mensal=6000)
  get_oportunidades_mensais(capital=130000, spread_width=5.0)
  get_oportunidades_mensais(capital=130000, iv_rank_periodo=252)
  ```
- **Fluxo:** (A) IV Rank ≥ 50 na janela `iv_rank_periodo`, (B) M9/M21 ≥ 1.0, (C) volume PUT ≥ R$5M → seleção da trava (vende maior bid no range; compra proteção ≈ `vendido − spread_width`) → dimensionamento de lotes para a meta dentro da margem (concentração máx. 35%/ativo).
- **`iv_rank_periodo` — qual janela usar?** `63` (padrão) reage rápido ao regime atual; `252` compara com a faixa anual inteira. Quando o mercado saiu de um pico recente de volatilidade, um ativo pode ter IV Rank baixo em 63d (ex.: 18%) mas alto em 252d (ex.: 58%) — usar `252` aprova mais candidatos nesse cenário. A escolha é refletida em `parametros.iv_rank_periodo` e nas mensagens de eliminação (ex.: `IV Rank 252d=44% < 50%`).
- **Regras de negócio:** nunca `M9/M21 < 1.0`, nunca `delta < -0.30`, descarta prêmio líquido `< R$0,40`.
- **Campos-chave:** `viabilidade` (meta_atingivel, ativos_aprovados/eliminados, `motivos_eliminacao`), `plano_execucao[]` (venda/compra/trava + `instrucao`), `resumo_financeiro`, `alertas`, `proxima_janela`.

> ⚠️ Em mercado de baixa (muitos ativos com M9/M21 < 1.0) ou liquidez fina nas pontas
> (prêmio líquido negativo), o plano sai **vazio com explicação** — isso é resposta
> legítima e prudente, não um erro.

---

## 15. Backtest quantitativo — venda contínua de PUTs (composta)

> Lógica em `src/utils/backtest_engine.ts` (`runQuantBacktest`). **Analítica — apenas simula.** Cache de **4h**.

### `get_backtest_quantitativo`
Backtest mecânico da venda contínua de PUTs OTM (Short Put / "The Wheel") sobre a série histórica do ativo, com **dimensionamento dinâmico de posição** (juros compostos). A cada ~21 pregões vende PUTs com strike `alvo_otm_pct` abaixo do spot, recebe um prêmio estimado e liquida no vencimento. Calcula métricas de risco institucionais.
- **Parâmetros:** **`ticker`**; opcionais — `capital_inicial` (50000), `dias_historico` (730; teto 2 anos), `alvo_otm_pct` (0.05 = 5% OTM ≈ Delta 30), `premio_estimado_pct` (0.02 = 2% do strike), `alocacao_margem_pct` (0.20 = 20% do caixa livre alocado como margem por ciclo).
- **Exemplos:**
  ```
  get_backtest_quantitativo(ticker="PETR4")
  get_backtest_quantitativo(ticker="VALE3", capital_inicial=100000, alvo_otm_pct=0.07)
  get_backtest_quantitativo(ticker="PETR4", alocacao_margem_pct=0.40)
  ```
- **Dimensionamento dinâmico (por ciclo):** `margem_disponivel = caixa_livre × alocacao_margem_pct`; `margem_por_opção = strike × 0.20`; `qtd = floor(floor(margem_disponivel / margem_por_opção) / 100) × 100` (múltiplo de 100, lote B3). Se `qtd < 100`, não entra (capital insuficiente). A base é o **caixa livre atual** → o tamanho cresce/encolhe com o resultado acumulado (juros compostos).
- **Mecânica no vencimento:** prêmio = `strike × premio_estimado_pct × qtd` (creditado na venda). `spot ≥ strike` → PUT vira pó (lucro = prêmio, WIN); `spot < strike` → exercício (prejuízo = `(strike − spot) × qtd`; P/L = prêmio − prejuízo, LOSS).
- **Métricas no retorno:** `capital_final`, `retorno_total_pct`, `win_rate_pct`, **`max_drawdown_pct`** (maior queda topo→fundo do capital), **`profit_factor`** (Σ lucros / Σ prejuízos; `> 1.5` = excelente; `null` quando não há perdas), `operacoes_realizadas`, `wins`/`losses`, `curva_capital[]` e `operacoes[]` detalhadas (incluindo `quantidade` e `margem_alocada` por ciclo).

> ⚠️ Aproximação **determinística**: strike e prêmio são estimados por percentuais
> (não usa a cadeia real de opções nem IV). Serve para medir o comportamento mecânico
> da estratégia ao longo do tempo, não para precificar uma operação específica.

---

Ver também: [README.md](README.md) (visão geral + deploy), [INDEX.md](INDEX.md) (mapa do
codebase), [CHANGELOG.md](CHANGELOG.md) (histórico de desenvolvimento).
