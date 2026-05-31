import express, { Request, Response } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import axios, { AxiosInstance } from "axios";
import { getIVRankHistorico, getIVRankBulk, normalizarPeriodo } from "./utils/iv_calculator.js";
import { getBacktestProtocolo2 } from "./utils/backtest_engine.js";
import { getOportunidadesMensais } from "./utils/opportunity_engine.js";

// ---------------------------------------------------------------------------
// OpLab API client
// ---------------------------------------------------------------------------

const OPLAB_BASE_URL = "https://api.oplab.com.br/v3";

function createOplabClient(): AxiosInstance {
  const token = process.env.OPLAB_ACCESS_TOKEN?.trim();
  if (!token) throw new Error("OPLAB_ACCESS_TOKEN environment variable is required");

  return axios.create({
    baseURL: OPLAB_BASE_URL,
    headers: {
      "Access-Token": token,
      "Accept": "application/json",
      "Content-Type": "application/json",
    },
    timeout: 15_000,
  });
}

// ---------------------------------------------------------------------------
// Tool registry — one entry per endpoint
// ---------------------------------------------------------------------------

interface PropDef {
  type?: string;
  description?: string;
  enum?: string[];
  items?: { type: string };
}

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, PropDef>;
  required: string[];
  // Ferramentas simples: mapeiam 1:1 para um GET na OpLab.
  build?: (args: Record<string, unknown>) => { path: string; params?: Record<string, unknown> };
  // Ferramentas compostas: lógica própria (múltiplas chamadas, cálculo, cache).
  handler?: (client: AxiosInstance, args: Record<string, unknown>) => Promise<unknown>;
}

const TOOL_REGISTRY: ToolDef[] = [
  // ── Interest Rates ────────────────────────────────────────────────────────
  {
    name: "get_interest_rates",
    description: "Listar todas as taxas de juros disponíveis (SELIC, CETIP, etc.)",
    properties: {}, required: [],
    build: () => ({ path: "/market/interest_rates" }),
  },
  {
    name: "get_interest_rate",
    description: "Consultar uma taxa de juros específica pela sua sigla (ex: SELIC, CDI).",
    properties: { id: { type: "string", description: "Sigla da taxa de juros (ex: SELIC, CDI)" } },
    required: ["id"],
    build: (a) => ({ path: `/market/interest_rates/${a.id}` }),
  },

  // ── Options ───────────────────────────────────────────────────────────────
  {
    name: "get_instrument_options",
    description: "Listar todas as opções disponíveis para uma ação (chain de opções), incluindo calls e puts com prêmios, strikes e vencimentos.",
    properties: { symbol: { type: "string", description: "Código da ação (ex: PETR4, VALE3)" } },
    required: ["symbol"],
    build: (a) => ({ path: `/market/options/${String(a.symbol).toUpperCase()}` }),
  },
  {
    name: "get_option",
    description: "Consultar detalhes de uma opção específica: prêmio, strike, vencimento, gregas (delta, gamma, theta, vega) e volatilidade implícita.",
    properties: { symbol: { type: "string", description: "Código de negociação da opção (ex: PETRH245)" } },
    required: ["symbol"],
    build: (a) => ({ path: `/market/options/details/${String(a.symbol).toUpperCase()}` }),
  },
  {
    name: "get_covered_options",
    description: "Listar opções recomendadas para estratégias cobertas (covered calls / cash-secured puts). Pode filtrar por ativo subjacente.",
    properties: { underlying: { type: "string", description: "Códigos das ações separados por vírgula para filtrar (opcional, ex: PETR4,VALE3)" } },
    required: [],
    build: (a) => ({ path: "/market/options/strategies/covered", params: pick(a, ["underlying"]) }),
  },
  {
    name: "get_options_bs",
    description: "Calcular Black-Scholes de uma opção: retorna prêmio teórico, gregas e volatilidade implícita dados os parâmetros informados.",
    properties: {
      symbol:    { type: "string",  description: "Código da opção (ex: PETRH245)" },
      irate:     { type: "number",  description: "Taxa de juros em % (ex: 10.75)" },
      type:      { type: "string",  description: "Tipo: CALL ou PUT (necessário se symbol for ação)", enum: ["CALL", "PUT"] },
      spotprice: { type: "number",  description: "Preço atual do ativo alvo" },
      strike:    { type: "number",  description: "Strike da opção" },
      premium:   { type: "number",  description: "Prêmio da opção" },
      dtm:       { type: "integer", description: "Dias até o vencimento" },
      vol:       { type: "number",  description: "Volatilidade implícita" },
      duedate:   { type: "string",  description: "Data de vencimento (YYYY-MM-DD)" },
      amount:    { type: "integer", description: "Quantidade de ativos" },
    },
    required: ["symbol", "irate"],
    build: (a) => ({ path: "/market/options/bs", params: pick(a, ["symbol", "irate", "type", "spotprice", "strike", "premium", "dtm", "vol", "duedate", "amount"]) }),
  },
  {
    name: "get_options_powders",
    description: "Listar os principais 'pozinhos' do mercado de opções (opções baratas com alto potencial de ganho).",
    properties: {}, required: [],
    build: () => ({ path: "/market/options/powders" }),
  },

  // ── Quote ─────────────────────────────────────────────────────────────────
  {
    name: "get_quote",
    description: "Consultar cotações em tempo real de uma lista de instrumentos (ações, opções, índices).",
    properties: { tickers: { type: "string", description: "Códigos separados por vírgula (ex: PETR4,VALE3,PETRH245)" } },
    required: ["tickers"],
    build: (a) => ({ path: "/market/quote", params: { tickers: a.tickers } }),
  },

  // ── Instruments ───────────────────────────────────────────────────────────
  {
    name: "search_instruments",
    description: "Pesquisar instrumentos por código ou nome da companhia. Suporta busca parcial e filtros por tipo (STOCK, OPTION, INDEX, etc.).",
    properties: {
      expr:        { type: "string",  description: "Termos de busca separados por vírgula (parciais aceitos, ex: PETR, Petrobras)" },
      limit:       { type: "number",  description: "Quantidade máxima de itens (padrão: 10)" },
      type:        { type: "string",  description: "Tipos separados por vírgula: STOCK, OPTION, INDEX, REAL_ESTATE_FUND, INDICATOR, INTEREST_RATE, BOND" },
      has_options: { type: "boolean", description: "Filtrar apenas instrumentos que têm opções listadas" },
      category:    { type: "string",  description: "Tipo de opção: CALL ou PUT (apenas quando type=OPTION)", enum: ["CALL", "PUT"] },
      add_info:    { type: "boolean", description: "Incluir informações adicionais (close, variation, volume, iv_current)" },
    },
    required: ["expr"],
    build: (a) => ({ path: "/market/instruments/search", params: pick(a, ["expr", "limit", "type", "has_options", "category", "add_info"]) }),
  },
  {
    name: "get_instrument_series",
    description: "Listar séries de opções de um instrumento (vencimentos disponíveis), com opção de incluir cálculo Black-Scholes.",
    properties: {
      symbol: { type: "string",  description: "Código de negociação do instrumento (ex: PETR4)" },
      bs:     { type: "boolean", description: "Ativar cálculo Black-Scholes (requer irate)" },
      irate:  { type: "number",  description: "Taxa de juros em % para o Black-Scholes (necessário quando bs=true)" },
    },
    required: ["symbol"],
    build: (a) => ({ path: `/market/instruments/series/${String(a.symbol).toUpperCase()}`, params: pick(a, ["bs", "irate"]) }),
  },
  {
    name: "get_instrument",
    description: "Consultar detalhes de um instrumento específico (ação, opção, índice, FII, etc.).",
    properties: { symbol: { type: "string", description: "Código de negociação (ex: PETR4, BOVA11, IBOV)" } },
    required: ["symbol"],
    build: (a) => ({ path: `/market/instruments/${String(a.symbol).toUpperCase()}` }),
  },
  {
    name: "get_instruments_detail",
    description: "Consultar detalhes de múltiplos instrumentos em uma única chamada.",
    properties: { tickers: { type: "string", description: "Códigos separados por vírgula (ex: PETR4,VALE3,ITUB4)" } },
    required: ["tickers"],
    build: (a) => ({ path: "/market/instruments", params: { tickers: a.tickers } }),
  },

  // ── Market Status ─────────────────────────────────────────────────────────
  {
    name: "get_market_status",
    description: "Consultar o status atual do mercado (aberto, fechado, pré-abertura, leilão, etc.).",
    properties: {}, required: [],
    build: () => ({ path: "/market/status" }),
  },

  // ── Companies ─────────────────────────────────────────────────────────────
  {
    name: "get_companies",
    description: "Consultar dados de múltiplas companhias com seleção granular de atributos, incluindo dados fundamentalistas (DRE, BPA, BPP, DFC), dividendos, setor e indicadores técnicos.",
    properties: {
      symbols:  { type: "string", description: "Códigos das ações separados por vírgula (ex: PETR4,VALE3)" },
      includes: { type: "string", description: "Atributos adicionais separados por vírgula. Opções: type, name, open, high, low, close, volume, financial_volume, trades, bid, ask, variation, has_options, middle_term_trend, short_term_trend, stdv_1y, stdv_5d, beta_ibov, ewma_current, iv_current, correl_ibov, m9_m21, oplab_score, sector, cvmCode, dre, bpp, bpa, dfc, stocks, dividends, fundamentals, cnpj" },
    },
    required: ["symbols"],
    build: (a) => ({ path: "/market/companies", params: pick(a, ["symbols", "includes"]) }),
  },

  // ── Stocks ────────────────────────────────────────────────────────────────
  {
    name: "get_stocks",
    description: "Listar ações que possuem opções listadas na B3, com ordenação e filtros por volume financeiro.",
    properties: {
      rank_by:                { type: "string",  description: "Atributo para ordenação (ex: volume, financial_volume, oplab_score, iv_current, variation)" },
      sort:                   { type: "string",  description: "Direção: asc ou desc", enum: ["asc", "desc"] },
      limit:                  { type: "integer", description: "Quantidade máxima de itens (padrão: 20)" },
      financial_volume_start: { type: "integer", description: "Volume financeiro mínimo" },
    },
    required: [],
    build: (a) => ({ path: "/market/stocks", params: pick(a, ["rank_by", "sort", "limit", "financial_volume_start"]) }),
  },
  {
    name: "get_stocks_all",
    description: "Listar todas as ações da B3 com paginação e ordenação.",
    properties: {
      page:                   { type: "integer", description: "Número da página (padrão: 1)" },
      per:                    { type: "integer", description: "Itens por página (padrão: 20)" },
      rank_by:                { type: "string",  description: "Atributo para ordenação (ex: symbol, volume, close)" },
      sort:                   { type: "string",  description: "Direção: asc ou desc", enum: ["asc", "desc"] },
      financial_volume_start: { type: "integer", description: "Volume financeiro mínimo" },
    },
    required: [],
    build: (a) => ({ path: "/market/stocks/all", params: pick(a, ["page", "per", "rank_by", "sort", "financial_volume_start"]) }),
  },
  {
    name: "get_stock",
    description: "Consultar dados de uma ação específica: preço, OHLC, volume, variação, volatilidade, gregas e opcionalmente dados fundamentalistas.",
    properties: {
      symbol:          { type: "string", description: "Código da ação (ex: PETR4, VALE3)" },
      with_financials: { type: "string", description: "Dados adicionais separados por vírgula: sector, name, cvmCode, currency, dre, bpp, bpa, dfc, stocks, close, dividends, fundamentals, cnpj" },
    },
    required: ["symbol"],
    build: (a) => ({ path: `/market/stocks/${String(a.symbol).toUpperCase()}`, params: pick(a, ["with_financials"]) }),
  },

  // ── Statistics — Realtime ──────────────────────────────────────────────────
  {
    name: "get_highest_options_volume",
    description: "Listar ações com maiores volumes em opções (calls, puts ou total) em tempo real.",
    properties: {
      order_by: { type: "string",  description: "Ordenar por: call, put ou total (padrão: total)", enum: ["call", "put", "total"] },
      limit:    { type: "integer", description: "Quantidade máxima de itens (padrão: 20)" },
    },
    required: [],
    build: (a) => ({ path: "/market/statistics/realtime/highest_options_volume", params: pick(a, ["order_by", "limit"]) }),
  },
  {
    name: "get_best_covered_options_rates",
    description: "Listar opções com as maiores taxas de retorno para estratégias cobertas (covered call ou cash-secured put).",
    properties: {
      type:  { type: "string",  description: "Tipo da opção: CALL ou PUT", enum: ["CALL", "PUT"] },
      limit: { type: "integer", description: "Quantidade máxima de itens (padrão: 20)" },
    },
    required: ["type"],
    build: (a) => ({ path: `/market/statistics/realtime/best_covered_options_rates/${a.type}`, params: pick(a, ["limit"]) }),
  },
  {
    name: "get_highest_options_variation",
    description: "Listar opções com as maiores variações de preço (calls ou puts) em tempo real.",
    properties: {
      type:  { type: "string",  description: "Tipo da opção: CALL ou PUT", enum: ["CALL", "PUT"] },
      limit: { type: "integer", description: "Quantidade máxima de itens (padrão: 20)" },
    },
    required: ["type"],
    build: (a) => ({ path: `/market/statistics/realtime/highest_options_variation/${a.type}`, params: pick(a, ["limit"]) }),
  },

  // ── Statistics — Ranking ───────────────────────────────────────────────────
  {
    name: "get_m9m21_ranking",
    description: "Listar ações com as maiores tendências de alta ou baixa segundo o indicador M9/M21 (médias móveis de 9 e 21 dias).",
    properties: {
      sort:                   { type: "string",  description: "asc = tendência de alta, desc = tendência de baixa", enum: ["asc", "desc"] },
      limit:                  { type: "integer", description: "Quantidade máxima de itens (padrão: 20)" },
      financial_volume_start: { type: "integer", description: "Volume financeiro mínimo" },
      days:                   { type: "integer", description: "Máximo de dias desde a última atualização (padrão: 3650)" },
    },
    required: [],
    build: (a) => ({ path: "/market/statistics/ranking/m9_m21", params: pick(a, ["sort", "limit", "financial_volume_start", "days"]) }),
  },
  {
    name: "get_correl_ibov_ranking",
    description: "Listar ações ordenadas pela correlação com o IBOVESPA.",
    properties: {
      sort:                   { type: "string",  description: "asc = maiores correlações, desc = menores correlações", enum: ["asc", "desc"] },
      limit:                  { type: "integer", description: "Quantidade máxima de itens (padrão: 20)" },
      financial_volume_start: { type: "integer", description: "Volume financeiro mínimo" },
      days:                   { type: "integer", description: "Máximo de dias desde a última atualização (padrão: 3650)" },
    },
    required: [],
    build: (a) => ({ path: "/market/statistics/ranking/correl_ibov", params: pick(a, ["sort", "limit", "financial_volume_start", "days"]) }),
  },
  {
    name: "get_companies_ranking",
    description: "Listar companhias ordenadas por um atributo fundamentalista (ROE, ROIC, EV/EBIT, Magic Formula, P/L, margem, etc.).",
    properties: {
      attribute: {
        type: "string",
        description: "Atributo fundamentalista para ordenação",
        enum: ["date", "cash_and_equivalents", "ebit", "earnings", "market_cap", "earnings_over_ebit", "earnings_over_netrevenue", "roic", "roa", "roe", "gross_margin", "ebit_margin", "net_margin", "interest_coverage_ratio", "current_ratio", "ev", "ev_over_ebit", "profit_per_share", "price_over_profit_per_share", "magic_formula"],
      },
      group_by:               { type: "string",  description: "Agrupar por: sector", enum: ["sector"] },
      sort:                   { type: "string",  description: "asc ou desc", enum: ["asc", "desc"] },
      limit:                  { type: "integer", description: "Quantidade máxima de itens (padrão: 20)" },
      financial_volume_start: { type: "integer", description: "Volume financeiro mínimo" },
    },
    required: ["attribute"],
    build: (a) => ({ path: `/market/statistics/ranking/${a.attribute}`, params: pick(a, ["group_by", "sort", "limit", "financial_volume_start"]) }),
  },
  {
    name: "get_oplab_score_ranking",
    description: "Listar ações ordenadas pelo OpLab Score (indicador proprietário de qualidade da empresa).",
    properties: {
      score_start:            { type: "integer", description: "OpLab Score mínimo" },
      financial_volume_start: { type: "integer", description: "Volume financeiro mínimo" },
      group_by:               { type: "string",  description: "Agrupar por: sector", enum: ["sector"] },
      sort:                   { type: "string",  description: "asc ou desc", enum: ["asc", "desc"] },
      limit:                  { type: "integer", description: "Quantidade máxima de itens (padrão: 20)" },
    },
    required: [],
    build: (a) => ({ path: "/market/statistics/ranking/oplab_score", params: pick(a, ["score_start", "financial_volume_start", "group_by", "sort", "limit"]) }),
  },

  // ── Historical ────────────────────────────────────────────────────────────
  {
    name: "get_historical_data",
    description: "Consultar série histórica de preços de um instrumento (OHLCV) com resolução configurável (1h, 1d, 1w, 1m, 1y).",
    properties: {
      symbol:     { type: "string",  description: "Código do instrumento (ex: PETR4, IBOV)" },
      resolution: { type: "string",  description: "Intervalo: ex. 1h, 1d, 1w, 1m, 1y (padrão: 1d)" },
      from:       { type: "string",  description: "Data de início (YYYY-MM-DD ou timestamp)" },
      to:         { type: "string",  description: "Data de fim (YYYY-MM-DD ou timestamp)" },
      amount:     { type: "integer", description: "Quantidade de períodos (alternativa a from/to)" },
      raw:        { type: "boolean", description: "Ignorar dados financeiros (valores zerados)" },
      smooth:     { type: "boolean", description: "Preencher closes zerados com o valor do dia anterior" },
      df:         { type: "string",  description: "Formato da data: timestamp ou iso", enum: ["timestamp", "iso"] },
    },
    required: ["symbol", "resolution", "from", "to"],
    build: (a) => ({ path: `/market/historical/${String(a.symbol).toUpperCase()}/${a.resolution}`, params: pick(a, ["from", "to", "amount", "raw", "smooth", "df"]) }),
  },
  {
    name: "get_historical_options",
    description: "Consultar o histórico de opções de um ativo em um intervalo de datas (snapshot diário de toda a cadeia de opções).",
    properties: {
      spot:   { type: "string", description: "Código da ação subjacente (ex: PETR4)" },
      from:   { type: "string", description: "Data de início (YYYY-MM-DD)" },
      to:     { type: "string", description: "Data de fim (YYYY-MM-DD)" },
      symbol: { type: "string", description: "Filtrar por código de uma opção específica (opcional)" },
    },
    required: ["spot", "from", "to"],
    build: (a) => ({ path: `/market/historical/options/${String(a.spot).toUpperCase()}/${a.from}/${a.to}`, params: pick(a, ["symbol"]) }),
  },
  {
    name: "get_historical_instruments",
    description: "Consultar dados de múltiplos instrumentos em uma data específica (snapshot histórico).",
    properties: {
      tickers: { type: "string", description: "Códigos separados por vírgula (ex: PETR4,VALE3)" },
      date:    { type: "string", description: "Data da consulta (YYYY-MM-DD)" },
    },
    required: ["tickers", "date"],
    build: (a) => ({ path: "/market/historical/instruments", params: pick(a, ["tickers", "date"]) }),
  },

  // ── Exchanges ─────────────────────────────────────────────────────────────
  {
    name: "get_exchanges",
    description: "Listar todas as bolsas de valores disponíveis na plataforma OpLab.",
    properties: {}, required: [],
    build: () => ({ path: "/market/exchanges" }),
  },
  {
    name: "get_exchange",
    description: "Consultar detalhes de uma bolsa de valores pelo seu UID.",
    properties: { uid: { type: "string", description: "UID da bolsa (ex: BVMF para a B3)" } },
    required: ["uid"],
    build: (a) => ({ path: `/market/exchanges/${a.uid}` }),
  },

  // ── Volatilidade Implícita — IV Rank ────────────────────────────────────────
  {
    name: "get_iv_rank_historico",
    description: "Calcular IV Rank e IV Percentile históricos de um ativo: compara a volatilidade implícita atual (iv_current da OpLab) com a faixa histórica de volatilidade realizada de 21 dias (anualizada). Retorna classificação operacional (MUITO_ALTA, ALTA, MEDIA, BAIXA), sinal de venda de opções e histórico mensal. Usa cache em memória de 4h.",
    properties: {
      ticker:  { type: "string",  description: "Código da ação (ex: VALE3, PETR4)" },
      periodo: { type: "integer", description: "Janela em dias úteis para o IV Rank. Padrão: 252. Aceita: 21, 63, 126, 252" },
    },
    required: ["ticker"],
    handler: (client, a) => getIVRankHistorico(client, String(a.ticker), normalizarPeriodo(a.periodo)),
  },
  {
    name: "get_iv_rank_bulk",
    description: "Calcular IV Rank de vários ativos de uma vez e ranquear por IV Rank decrescente. Sem o parâmetro 'tickers', usa a whitelist padrão de 24 ativos líquidos. Usa cache de 4h (tickers em cache não consomem chamadas) e processa os demais em lotes de 3 com 300ms entre lotes para evitar rate limit (HTTP 429). Ideal para triagem de oportunidades de venda de opções.",
    properties: {
      tickers: { type: "array",   description: "Lista de códigos de ações (ex: [\"VALE3\",\"PETR4\"]). Se omitido, usa a whitelist padrão de 24 ativos.", items: { type: "string" } },
      periodo: { type: "integer", description: "Janela em dias úteis para o IV Rank. Padrão: 252. Aceita: 21, 63, 126, 252" },
    },
    required: [],
    handler: (client, a) => getIVRankBulk(client, a.tickers as string[] | undefined, normalizarPeriodo(a.periodo)),
  },

  // ── Backtesting — Protocolo 2 (venda de PUTs OTM) ───────────────────────────
  {
    name: "get_backtest_protocolo2",
    description:
      "Ferramenta ANALÍTICA (apenas simula — não executa ordens reais). Faz backtesting histórico do Protocolo 2 (venda de PUTs OTM) sobre dados da OpLab: para cada dia útil aplica os filtros IV Rank, tendência M9/M21 e seleciona a PUT candidata (delta e DTE no range), simulando o resultado no vencimento. Com use_spread=true, simula trava Bull Put Spread (perda limitada) em vez de PUT a descoberto. Retorna resumo geral, comparativo de filtros (prova estatística do valor do protocolo), desempenho por ativo, por mês e curva de capital. Sem 'tickers', usa a whitelist padrão de 24 ativos. Cache de 24h; lotes de 3 ativos com 500ms entre lotes; período máximo de 2 anos.",
    properties: {
      tickers:      { type: "array",   description: "Lista de códigos (ex: [\"VALE3\",\"PETR4\"]). Se omitido, usa a whitelist padrão de 24 ativos.", items: { type: "string" } },
      data_inicio:  { type: "string",  description: "Data inicial YYYY-MM-DD. Padrão: 2 anos atrás." },
      data_fim:     { type: "string",  description: "Data final YYYY-MM-DD. Padrão: hoje." },
      delta_min:    { type: "number",  description: "Delta mínimo (mais negativo) da PUT. Padrão: -0.30" },
      delta_max:    { type: "number",  description: "Delta máximo (menos negativo) da PUT. Padrão: -0.15" },
      dte_min:      { type: "integer", description: "Dias até o vencimento mínimo. Padrão: 15" },
      dte_max:      { type: "integer", description: "Dias até o vencimento máximo. Padrão: 30" },
      iv_rank_min:  { type: "integer", description: "IV Rank mínimo no dia da entrada. Padrão: 50" },
      m9m21_filter: { type: "boolean", description: "Se true, exige tendência de alta (M9/M21 >= 1.0). Padrão: true" },
      use_spread:   { type: "boolean", description: "Se true, simula trava Bull Put Spread (perda máxima limitada) em vez de PUT a descoberto. Padrão: false" },
      spread_width: { type: "number",  description: "Largura alvo da trava em R$ (distância entre o strike vendido e o comprado). Padrão: 3.00. Só usado quando use_spread=true." },
    },
    required: [],
    handler: (client, a) => getBacktestProtocolo2(client, a),
  },

  // ── Plano mensal de travas Bull Put Spread ──────────────────────────────────
  {
    name: "get_oportunidades_mensais",
    description:
      "Ferramenta ANALÍTICA (apenas sugere um plano — não envia ordens). Monta um plano mensal de travas Bull Put Spread que, combinadas, buscam atingir a meta de prêmio líquido do mês respeitando capital e margem disponíveis. Aplica filtros de qualidade (IV Rank >= 50, tendência M9/M21 >= 1.0, volume de PUT >= R$5M), seleciona a trava real da cadeia ao vivo (delta/bid/ask reais) e dimensiona os lotes. Retorna viabilidade, plano de execução com instruções por trava, resumo financeiro e alertas. Sem 'tickers', usa 12 ativos pré-selecionados. DICA DE USO: se a resposta vier com muitos ativos eliminados por 'iv_rank_baixo' (motivos_eliminacao.iv_rank_baixo alto), chame de novo passando iv_rank_periodo=252 — a janela de 63d (padrão) reage ao regime recente e pode reprovar ativos que têm IV Rank alto na faixa anual. Se os ativos forem eliminados por 'sem_trava_viavel', o gargalo é o prêmio da cadeia (não o IV Rank): mudar o período não ajuda.",
    properties: {
      capital:        { type: "number",  description: "Capital total disponível em R$ (ex: 130000). OBRIGATÓRIO." },
      meta_mensal:    { type: "number",  description: "Prêmio líquido alvo no mês em R$. Padrão: 4000" },
      margem_max_pct: { type: "number",  description: "Fração máxima do capital alocada em margem (0-1). Padrão: 0.35" },
      spread_width:   { type: "number",  description: "Distância em R$ entre o strike vendido e o comprado. Padrão: 3.0" },
      delta_min:      { type: "number",  description: "Delta mais negativo aceito na PUT vendida. Padrão: -0.25 (nunca abaixo de -0.30)" },
      delta_max:      { type: "number",  description: "Delta menos negativo aceito na PUT vendida. Padrão: -0.15" },
      dte_min:        { type: "integer", description: "Dias até o vencimento mínimo. Padrão: 15" },
      dte_max:        { type: "integer", description: "Dias até o vencimento máximo. Padrão: 30" },
      iv_rank_periodo:{ type: "integer", description: "Janela do IV Rank para o filtro de qualidade: 21, 63, 126 ou 252. Padrão: 63 (reage ao regime atual). 252 compara com a faixa anual inteira — costuma aprovar mais ativos quando o mercado saiu de um pico recente de volatilidade." },
      tickers:        { type: "array",   description: "Lista de ativos a avaliar. Se omitido, usa 12 ativos pré-selecionados.", items: { type: "string" } },
    },
    required: ["capital"],
    handler: (client, a) => getOportunidadesMensais(client, a),
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pick(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(
    keys.filter((k) => obj[k] !== undefined && obj[k] !== null && obj[k] !== "").map((k) => [k, obj[k]])
  );
}

// Retry helper — retries only on 5xx transient errors with exponential backoff
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      const isServerError = axios.isAxiosError(e) && (e.response?.status ?? 0) >= 500;
      if (i === attempts - 1 || !isServerError) throw e;
      await new Promise<void>((r) => setTimeout(r, 2 ** i * 1_000));
    }
  }
  throw new Error("unreachable");
}

// Static tool list derived from TOOL_REGISTRY — returned verbatim by ListTools
const TOOLS_LIST = TOOL_REGISTRY.map(({ name, description, properties, required }) => ({
  name,
  description,
  inputSchema: { type: "object" as const, properties, required },
}));

// ---------------------------------------------------------------------------
// Global MCP server — singleton, handlers registered once at module load
// ---------------------------------------------------------------------------

let oplabClient: AxiosInstance;
try {
  oplabClient = createOplabClient();
} catch (err) {
  console.error(err);
  process.exit(1);
}

const server = new Server(
  { name: "oplab-mcp-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS_LIST }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  const entry = TOOL_REGISTRY.find((t) => t.name === name);

  if (!entry) {
    return { content: [{ type: "text" as const, text: `Ferramenta desconhecida: ${name}` }], isError: true };
  }

  const start = Date.now();
  console.log(JSON.stringify({ event: "tool_call", tool: name }));
  try {
    // Ferramentas compostas usam handler próprio; as simples mapeiam para um GET.
    const data = entry.handler
      ? await entry.handler(oplabClient, args as Record<string, unknown>)
      : await withRetry(async () => {
          const { path, params } = entry.build!(args as Record<string, unknown>);
          return (await oplabClient.get(path, { params })).data;
        });
    console.log(JSON.stringify({ event: "tool_ok", tool: name, ms: Date.now() - start }));
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  } catch (error) {
    const message = axios.isAxiosError(error)
      ? `Erro OpLab [${error.response?.status}]: ${JSON.stringify(error.response?.data)}`
      : String(error);
    console.error(JSON.stringify({ event: "tool_error", tool: name, ms: Date.now() - start, error: message }));
    return { content: [{ type: "text" as const, text: message }], isError: true };
  }
});

// ---------------------------------------------------------------------------
// Express + SSE transport
// ---------------------------------------------------------------------------

const app = express();

let sseTransport: SSEServerTransport | null = null;

app.get("/health", async (_req: Request, res: Response) => {
  try {
    await oplabClient.get("/market/status", { timeout: 5_000 });
    res.json({ status: "ok", tools: TOOL_REGISTRY.length, api: "reachable" });
  } catch {
    res.json({ status: "ok", tools: TOOL_REGISTRY.length, api: "unreachable" });
  }
});

app.get("/sse", async (_req: Request, res: Response) => {
  // Close any previous transport so Protocol.connect() doesn't throw "Already connected"
  if (sseTransport) {
    await sseTransport.close();
    sseTransport = null;
  }
  sseTransport = new SSEServerTransport("/messages", res);
  await server.connect(sseTransport);
  // Keep connection alive — Cloud Run suspends CPU on idle SSE streams without this
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 30_000);
  res.on("close", () => clearInterval(heartbeat));
});

app.post("/messages", express.text({ type: "application/json" }), async (req: Request, res: Response) => {
  // Pass req.body (string) as parsedBody so handlePostMessage skips raw-body stream reading
  await sseTransport?.handlePostMessage(req, res, req.body as string);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT ?? "8080", 10);

app.listen(PORT, () => {
  console.log(`OpLab MCP Server — ${TOOL_REGISTRY.length} ferramentas disponíveis`);
  console.log(`  SSE  → GET  http://localhost:${PORT}/sse`);
  console.log(`  Msgs → POST http://localhost:${PORT}/messages?sessionId=<id>`);
  console.log(`  Health → GET http://localhost:${PORT}/health`);
});

process.on("SIGTERM", async () => {
  console.log(JSON.stringify({ event: "shutdown" }));
  if (sseTransport) await sseTransport.close();
  process.exit(0);
});
