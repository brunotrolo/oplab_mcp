import express, { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import axios, { AxiosInstance } from "axios";
import { z } from "zod";

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
}

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, PropDef>;
  required: string[];
  build: (args: Record<string, unknown>) => { path: string; params?: Record<string, unknown> };
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
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pick(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(
    keys.filter((k) => obj[k] !== undefined && obj[k] !== null && obj[k] !== "").map((k) => [k, obj[k]])
  );
}

function propToZod(prop: PropDef, isRequired: boolean): z.ZodTypeAny {
  const enumVals = prop.enum;
  let schema: z.ZodTypeAny;

  if (enumVals && enumVals.length > 0) {
    schema = z.enum(enumVals as [string, ...string[]]);
  } else if (prop.type === "integer") {
    schema = z.number().int();
  } else if (prop.type === "number") {
    schema = z.number();
  } else if (prop.type === "boolean") {
    schema = z.boolean();
  } else {
    schema = z.string();
  }

  if (prop.description) schema = schema.describe(prop.description);
  return isRequired ? schema : schema.optional();
}

// ---------------------------------------------------------------------------
// Global OpLab client + McpServer — instantiated once at module load
// ---------------------------------------------------------------------------

let oplabClient: AxiosInstance;
try {
  oplabClient = createOplabClient();
} catch (err) {
  console.error(err);
  process.exit(1);
}

const server = new McpServer({ name: "oplab-mcp-server", version: "1.0.0" });

for (const entry of TOOL_REGISTRY) {
  const shape: Record<string, z.ZodTypeAny> = Object.fromEntries(
    Object.entries(entry.properties).map(([k, v]) => [
      k,
      propToZod(v, entry.required.includes(k)),
    ])
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic shape defeats TS generic inference; Zod validates at runtime
  (server.registerTool as any)(entry.name, { description: entry.description, inputSchema: shape }, async (args: Record<string, unknown>) => {
    try {
      const { path, params } = entry.build(args);
      const { data } = await oplabClient.get(path, { params });
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      const message = axios.isAxiosError(error)
        ? `Erro OpLab [${error.response?.status}]: ${JSON.stringify(error.response?.data)}`
        : String(error);
      return { content: [{ type: "text" as const, text: message }], isError: true };
    }
  });
}

// ---------------------------------------------------------------------------
// Express + SSE transport
// ---------------------------------------------------------------------------

const app = express();

let sseTransport: SSEServerTransport | null = null;

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", tools: TOOL_REGISTRY.length });
});

app.get("/sse", async (_req: Request, res: Response) => {
  sseTransport = new SSEServerTransport("/messages", res);
  await server.connect(sseTransport);
});

app.post("/messages", express.text({ type: "application/json" }), async (req: Request, res: Response) => {
  await sseTransport?.handlePostMessage(req, res);
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
