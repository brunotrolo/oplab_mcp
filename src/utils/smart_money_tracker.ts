// ---------------------------------------------------------------------------
// Smart Money Tracker — "Whale & Block Trade Tracker"
//
// Rastreia fluxo institucional anômalo na cadeia de opções da OpLab. Como a API
// NÃO expõe Open Interest (verificado em todos os endpoints), o conceito original
// vol/OI foi pivotado para detecção de BLOCK TRADES: opções com alto volume
// financeiro no dia cujo TICKET MÉDIO por negócio é de porte institucional
// (varejo fracionado não sustenta ticket médio alto em opções).
//
// Arquivo isolado de src/index.ts (regra de arquitetura): toda a lógica vive aqui;
// o index.ts apenas registra a ferramenta com um `handler`.
//
// Dados REAIS usados (todos presentes em /market/options/{ticker}):
//   volume, financial_volume, trades, close, strike, days_to_maturity, type.
//   ⚠️ `delta` NÃO vem nesta rota (só via series?bs=true, ~4MB/ativo) → retornado
//      como null para não inflar a varredura nem inventar dados.
// ---------------------------------------------------------------------------

import { AxiosInstance } from "axios";
import { batchWithLimit, WHITELIST_24 } from "./iv_calculator.js";

const REQUEST_TIMEOUT_MS = 20_000; // a chain pode ser grande
const DTE_MAX_DEFAULT = 45;
const MIN_FINANCIAL_VOLUME_DEFAULT = 250_000;
const MIN_AVG_FIN_PER_TRADE_DEFAULT = 5_000;

const round2 = (n: number): number => Math.round(n * 100) / 100;

function num(v: unknown, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

// ── Tipos ────────────────────────────────────────────────────────────────────

export interface SmartMoneyParams {
  tickers: string[];
  min_financial_volume: number;
  min_avg_financial_per_trade: number;
  dte_max: number;
}

export interface Radar {
  ticker_opcao: string;
  ativo_base: string;
  tipo: string;
  strike: number;
  close: number;
  financial_volume: number;
  volume: number;
  trades: number | null;                 // null: a chain da OpLab não populou trades
  avg_contracts_per_trade: number | null; // null quando trades indisponível
  avg_financial_per_trade: number | null; // null quando trades indisponível
  // Preço médio por contrato (financial_volume / volume) — sempre calculável,
  // serve de proxy do "tamanho" do contrato quando trades não vem.
  preco_medio_contrato: number | null;
  delta: number | null;                  // null: gregas não vêm na chain
  days_to_maturity: number;
  base_ticket: "trades" | "financeiro";  // como o ticket institucional foi avaliado
}

export interface SmartMoneyResult {
  data_varredura: string;
  parametros: SmartMoneyParams;
  ativos_analisados: number;
  anomalias_encontradas: number;
  radares: Radar[];
  alertas: string[];
}

// ── Normalização de parâmetros ────────────────────────────────────────────────

export function normalizarSmartMoneyParams(a: Record<string, unknown>): SmartMoneyParams {
  const tickers =
    Array.isArray(a.tickers) && a.tickers.length
      ? a.tickers.map((t) => String(t).toUpperCase())
      : [...WHITELIST_24];
  return {
    tickers,
    min_financial_volume: Math.max(0, num(a.min_financial_volume, MIN_FINANCIAL_VOLUME_DEFAULT)),
    min_avg_financial_per_trade: Math.max(0, num(a.min_avg_financial_per_trade, MIN_AVG_FIN_PER_TRADE_DEFAULT)),
    dte_max: Math.max(0, Math.round(num(a.dte_max, DTE_MAX_DEFAULT))),
  };
}

// ── Parsing de uma opção da chain ─────────────────────────────────────────────

interface ChainOption {
  symbol: string;
  ativo_base: string;
  tipo: string;
  strike: number;
  close: number;
  volume: number;
  financial_volume: number;
  trades: number;
  dte: number;
}

/** Extrai e tipa as opções da resposta de /market/options/{ticker}. */
function extractChain(raw: unknown, tickerConsultado: string): ChainOption[] {
  const rows = Array.isArray(raw) ? raw : [];
  return rows
    .map((row): ChainOption => {
      const r = row as Record<string, unknown>;
      const parent = String(r.parent_symbol ?? "").toUpperCase() || tickerConsultado;
      return {
        symbol: String(r.symbol ?? ""),
        ativo_base: parent,
        tipo: String(r.type ?? r.category ?? "").toUpperCase(),
        strike: Number(r.strike),
        close: Number(r.close),
        volume: Number(r.volume),
        financial_volume: Number(r.financial_volume),
        trades: Number(r.trades),
        dte: Number(r.days_to_maturity),
      };
    })
    .filter((o) => o.symbol !== "");
}

// ── Varredura de um ticker ────────────────────────────────────────────────────

interface TickerScan {
  ticker: string;
  radares: Radar[];
  erro?: string;
}

async function scanTicker(client: AxiosInstance, ticker: string, p: SmartMoneyParams): Promise<TickerScan> {
  const tk = ticker.toUpperCase();
  let chain: ChainOption[];
  try {
    const { data } = await client.get(`/market/options/${tk}`, { timeout: REQUEST_TIMEOUT_MS });
    chain = extractChain(data, tk);
  } catch (e) {
    const status = (e as { response?: { status?: number } })?.response?.status;
    return { ticker: tk, radares: [], erro: `${tk}: falha ao buscar opções${status ? ` (HTTP ${status})` : ""}.` };
  }

  const radares: Radar[] = [];
  for (const o of chain) {
    // Filtros básicos: DTE no curto prazo e volume financeiro relevante.
    if (!Number.isFinite(o.dte) || o.dte > p.dte_max) continue;
    if (!Number.isFinite(o.financial_volume) || o.financial_volume <= 0) continue;
    if (o.financial_volume < p.min_financial_volume) continue;

    const temTrades = Number.isFinite(o.trades) && o.trades > 0;

    // Filtro institucional do TICKET MÉDIO por negócio — só aplicável quando a
    // OpLab popula `trades`. Na prática a chain costuma vir com trades=0; nesse
    // caso degrada para o filtro por volume financeiro (já aplicado acima),
    // sinalizando base_ticket="financeiro" para transparência.
    let avgContracts: number | null = null;
    let avgFinanceiro: number | null = null;
    if (temTrades) {
      avgContracts = o.volume / o.trades;
      avgFinanceiro = o.financial_volume / o.trades;
      if (avgFinanceiro < p.min_avg_financial_per_trade) continue; // reprova ticket baixo
    }

    const precoMedioContrato = o.volume > 0 ? o.financial_volume / o.volume : null;

    radares.push({
      ticker_opcao: o.symbol,
      ativo_base: o.ativo_base,
      tipo: o.tipo,
      strike: round2(o.strike),
      close: round2(o.close),
      financial_volume: round2(o.financial_volume),
      volume: o.volume,
      trades: temTrades ? o.trades : null,
      avg_contracts_per_trade: avgContracts !== null ? round2(avgContracts) : null,
      avg_financial_per_trade: avgFinanceiro !== null ? round2(avgFinanceiro) : null,
      preco_medio_contrato: precoMedioContrato !== null ? round2(precoMedioContrato) : null,
      delta: null, // gregas não vêm na chain (ver cabeçalho do arquivo)
      days_to_maturity: o.dte,
      base_ticket: temTrades ? "trades" : "financeiro",
    });
  }
  return { ticker: tk, radares };
}

// ── Orquestração ──────────────────────────────────────────────────────────────

/**
 * Varre a cadeia de opções dos tickers em busca de block trades institucionais.
 * Processa em lotes de 3 com 300ms entre lotes (evita HTTP 429). Ordena o
 * resultado por volume financeiro decrescente (onde o smart money despejou mais).
 */
export async function getSmartMoneyTracker(client: AxiosInstance, args: Record<string, unknown>): Promise<SmartMoneyResult> {
  const p = normalizarSmartMoneyParams(args);

  const scans = await batchWithLimit(p.tickers, (tk) => scanTicker(client, tk, p), 3, 300);

  const radares: Radar[] = [];
  const alertas: string[] = [];
  for (const s of scans) {
    radares.push(...s.radares);
    if (s.erro) alertas.push(`⚠️ ${s.erro}`);
  }

  // Ordena decrescente por volume financeiro bruto — maior despejo no topo.
  radares.sort((a, b) => b.financial_volume - a.financial_volume);

  if (radares.length === 0) {
    alertas.push(
      "Nenhuma anomalia de block trade encontrada hoje com os critérios atuais. " +
        "Mercado sem fluxo institucional anômalo detectável ou liquidez baixa nas opções."
    );
  }
  // Transparência sobre os dados que a OpLab NÃO fornece na chain.
  const algumSemTrades = radares.some((r) => r.base_ticket === "financeiro");
  if (algumSemTrades) {
    alertas.push(
      "ℹ️ A chain /market/options não populou `trades` para parte/todas as opções " +
        "(ticket médio por negócio indisponível). Nesses casos o filtro de ticket é " +
        "ignorado e a triagem usa apenas o volume financeiro (base_ticket=\"financeiro\"); " +
        "veja `preco_medio_contrato` como proxy do tamanho do contrato."
    );
  }
  alertas.push(
    "ℹ️ delta retornado como null: a chain /market/options não expõe gregas " +
      "(só via series?bs=true, ~4MB/ativo — omitido para não inflar a varredura)."
  );

  return {
    data_varredura: new Date().toISOString(),
    parametros: p,
    ativos_analisados: p.tickers.length,
    anomalias_encontradas: radares.length,
    radares,
    alertas,
  };
}
