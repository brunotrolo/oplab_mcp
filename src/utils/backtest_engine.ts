// ---------------------------------------------------------------------------
// Backtest engine — simulação histórica do "Protocolo 2" (venda de PUTs OTM).
//
// Arquivo SEPARADO de src/index.ts: toda a lógica de backtesting vive aqui para
// manter o index.ts enxuto e o transporte SSE estável (ver CLAUDE.md). O index.ts
// apenas registra a ferramenta 32 (get_backtest_protocolo2) com um `handler`.
//
// ⚠️ Ferramenta ANALÍTICA — apenas simula operações sobre dados históricos.
//    Não executa nenhuma ordem real.
//
// Fontes de dados OpLab:
//   • GET /market/historical/{ticker}/1d        → série de preços (1 call/ativo)
//   • GET /market/historical/options/{spot}/{from}/{to} → cadeia de opções por dia
//     (tem delta, premium, days_to_maturity, strike, type, due_date — NÃO tem
//      bid/volume; usamos premium>0 como proxy de liquidez).
//   • Volume de PUT por dia NÃO existe no histórico → filtro de volume é marcado
//     como "volume_nao_verificado" (ver limitação #2 do enunciado).
// ---------------------------------------------------------------------------

import { AxiosInstance } from "axios";
import { calcRetornosLog, calcVolatilidade21d, calcIVRank, batchWithLimit, WHITELIST_24 } from "./iv_calculator.js";

// ── Constantes ───────────────────────────────────────────────────────────────

/** Fator de stress de margem (22% do nocional) — simplificação do enunciado. */
const MARGIN_STRESS_FACTOR = 0.22;
const CONTRACT_SIZE = 100;

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h — backtest histórico não muda
const PER_TICKER_BUDGET_MS = 10_000;       // timeout/orçamento por ativo
const REQUEST_TIMEOUT_MS = 10_000;         // timeout por chamada HTTP
const MAX_PERIOD_DAYS = 730;               // 2 anos (limitação #5)
const MAX_PREV_DAY_RETRIES = 3;            // limitação #1

const backtestCache = new Map<string, { data: BacktestResult; timestamp: number }>();

/** Limpa o cache de backtest (usado em testes). */
export function clearBacktestCache(): void {
  backtestCache.clear();
}

// ── Helpers numéricos / datas ────────────────────────────────────────────────

const round2 = (n: number): number => Math.round(n * 100) / 100;
const round1 = (n: number): number => Math.round(n * 10) / 10;
const DAY_MS = 24 * 60 * 60 * 1000;

function toDateStr(t: number): string {
  const ms = t < 1e12 ? t * 1000 : t;
  return new Date(ms).toISOString().slice(0, 10);
}

/** "YYYY-MM-DD" → Date (UTC meia-noite). */
function parseDate(s: string): Date {
  return new Date(`${s.slice(0, 10)}T00:00:00.000Z`);
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Próximo vencimento padrão da B3: 3ª sexta-feira do mês, em ou após `data`.
 * Exportada pois o enunciado pede a função; serve de fallback quando o due_date
 * da opção não está presente.
 */
export function calcProximoVencimentoB3(data: Date): Date {
  const tryMonth = (year: number, month: number): Date => {
    const first = new Date(Date.UTC(year, month, 1));
    // getUTCDay: 0=dom … 5=sex. Primeira sexta:
    const firstFriday = 1 + ((5 - first.getUTCDay() + 7) % 7);
    return new Date(Date.UTC(year, month, firstFriday + 14)); // 3ª sexta
  };
  let y = data.getUTCFullYear();
  let m = data.getUTCMonth();
  let venc = tryMonth(y, m);
  if (venc.getTime() < data.getTime()) {
    m += 1;
    if (m > 11) { m = 0; y += 1; }
    venc = tryMonth(y, m);
  }
  return venc;
}

// ── Tipos ────────────────────────────────────────────────────────────────────

export interface BacktestParams {
  tickers: string[];
  data_inicio: string;
  data_fim: string;
  delta_min: number;
  delta_max: number;
  dte_min: number;
  dte_max: number;
  iv_rank_min: number;
  m9m21_filter: boolean;
  use_spread: boolean;
  spread_width: number;
  periodo_dias: number;
}

export interface Candle {
  date: string;
  close: number;
}

export interface OptionRow {
  type: string;
  strike: number;
  premium: number;
  delta: number;
  dte: number;
  due_date: string;
}

export interface SimOp {
  ticker: string;
  entrada_date: string;
  expiry_date: string;
  strike: number;
  premio_entrada: number;
  delta: number;
  dte: number;
  spot_vencimento: number;
  resultado: "WIN" | "LOSS";
  pl: number;
  pl_pct: number;
  margem: number;
  retorno_margem_pct: number;
  volume_nao_verificado: boolean;
  // Estrutura da operação. NAKED_PUT (default) ou BULL_PUT_SPREAD (use_spread=true).
  estrutura: "NAKED_PUT" | "BULL_PUT_SPREAD";
  strike_protecao?: number;
  premio_protecao?: number;
  premio_liquido?: number;
  perda_maxima?: number;
}

interface VariantAgg {
  operacoes: number;
  win_rate_pct: number;
  pl_total: number;
}

export interface BacktestResult {
  parametros: BacktestParams;
  resumo_geral: {
    total_operacoes: number;
    wins: number;
    losses: number;
    win_rate_pct: number;
    pl_total_estimado: number;
    retorno_medio_por_op: number;
    retorno_medio_sobre_margem_pct: number;
    maior_sequencia_wins: number;
    maior_sequencia_losses: number;
    cache_hit: boolean;
    tempo_execucao_ms: number;
  };
  comparativo_filtros: {
    com_todos_filtros: VariantAgg;
    sem_iv_rank: VariantAgg;
    sem_m9m21: VariantAgg;
    sem_nenhum_filtro: VariantAgg;
  };
  por_ativo: Array<{
    ticker: string;
    operacoes: number;
    wins: number;
    losses: number;
    win_rate_pct: number;
    pl_total: number;
    melhor_op: { data: string; pl: number } | null;
    pior_op: { data: string; pl: number } | null;
  }>;
  por_mes: Array<{
    mes: string;
    operacoes: number;
    wins: number;
    losses: number;
    win_rate_pct: number;
    pl_mes: number;
    capital_acumulado: number;
  }>;
  curva_capital: Array<{ data: string; pl_acumulado: number }>;
  alertas: string[];
}

// ── Parsing das respostas da OpLab ────────────────────────────────────────────

export function extractCandles(raw: unknown): Candle[] {
  const obj = raw as Record<string, unknown> | undefined;
  const rows = Array.isArray(raw) ? raw : obj && Array.isArray(obj.data) ? (obj.data as unknown[]) : [];
  return rows
    .map((row): Candle => {
      const r = row as Record<string, unknown>;
      const close = Number(r.close ?? r.c ?? r.price);
      const rawDate = r.date ?? r.datetime ?? r.time;
      const date = typeof rawDate === "string" ? rawDate.slice(0, 10) : toDateStr(Number(rawDate));
      return { date, close };
    })
    .filter((c) => isFinite(c.close) && c.close > 0 && c.date.length === 10)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Normaliza a cadeia de opções de um dia em OptionRow[]. */
export function extractOptions(raw: unknown): OptionRow[] {
  const rows = Array.isArray(raw) ? raw : [];
  return rows
    .map((row): OptionRow => {
      const r = row as Record<string, unknown>;
      const dueRaw = r.due_date;
      return {
        type: String(r.type ?? r.category ?? "").toUpperCase(),
        strike: Number(r.strike),
        premium: Number(r.premium ?? r.close ?? r.bs),
        delta: Number(r.delta),
        dte: Number(r.days_to_maturity),
        due_date: typeof dueRaw === "string" ? dueRaw.slice(0, 10) : "",
      };
    })
    .filter((o) => o.type === "PUT" && isFinite(o.strike) && isFinite(o.delta) && isFinite(o.premium));
}

// ── Indicadores por dia (sem chamadas à API) ─────────────────────────────────

function sma(values: number[], end: number, window: number): number {
  if (end - window + 1 < 0) return NaN;
  let s = 0;
  for (let i = end - window + 1; i <= end; i++) s += values[i];
  return s / window;
}

/**
 * Constrói, por índice de candle, a vol_21d anualizada e o IV Rank histórico
 * (rank da vol_21d do dia dentro da janela móvel de 252 valores anteriores).
 */
export function buildIndicators(closes: number[]): { vol21: number[]; ivRank: number[]; m9m21: number[] } {
  const retornos = calcRetornosLog(closes);
  const vol21 = closes.map((_, j) => (j >= 21 ? calcVolatilidade21d(retornos, j - 1) : NaN));

  const ivRank = closes.map((_, j) => {
    if (!isFinite(vol21[j])) return NaN;
    const janela: number[] = [];
    for (let k = Math.max(21, j - 251); k <= j; k++) if (isFinite(vol21[k])) janela.push(vol21[k]);
    return janela.length >= 21 ? calcIVRank(vol21[j], janela) : NaN;
  });

  const m9m21 = closes.map((_, j) => {
    const m9 = sma(closes, j, 9);
    const m21 = sma(closes, j, 21);
    return isFinite(m9) && isFinite(m21) && m21 > 0 ? m9 / m21 : NaN;
  });

  return { vol21, ivRank, m9m21 };
}

// ── Seleção da PUT candidata ──────────────────────────────────────────────────

export function selectPut(chain: OptionRow[], p: BacktestParams): OptionRow | null {
  const candidatas = chain.filter(
    (o) =>
      o.dte >= p.dte_min &&
      o.dte <= p.dte_max &&
      o.delta >= p.delta_min &&
      o.delta <= p.delta_max &&
      o.premium > 0 // proxy de liquidez (bid não existe no histórico)
  );
  if (candidatas.length === 0) return null;
  // Delta mais próximo do centro do range; desempate por maior prêmio (Max Gain).
  const centro = (p.delta_min + p.delta_max) / 2;
  candidatas.sort((a, b) => {
    const da = Math.abs(a.delta - centro);
    const db = Math.abs(b.delta - centro);
    if (Math.abs(da - db) > 1e-9) return da - db;
    return b.premium - a.premium;
  });
  return candidatas[0];
}

/**
 * Perna de proteção do Bull Put Spread: a PUT comprada do MESMO vencimento com
 * strike mais próximo de (strike_vendido - spread_width), abaixo do strike vendido.
 * Usa os prêmios reais da cadeia (sem modelagem teórica).
 */
export function selectProtective(chain: OptionRow[], sold: OptionRow, spreadWidth: number): OptionRow | null {
  const alvo = sold.strike - spreadWidth;
  const protecoes = chain.filter(
    (o) => o.due_date === sold.due_date && o.strike < sold.strike && o.premium >= 0 && isFinite(o.strike)
  );
  if (protecoes.length === 0) return null;
  protecoes.sort((a, b) => Math.abs(a.strike - alvo) - Math.abs(b.strike - alvo));
  return protecoes[0];
}

// ── Simulação de uma operação no vencimento ───────────────────────────────────

/**
 * Simula a operação no vencimento.
 * - NAKED_PUT (default): WIN = prêmio cheio; LOSS = (prêmio - (strike - spot)) — perda grande.
 * - BULL_PUT_SPREAD (use_spread): vende a PUT e compra a proteção. P/L limitado:
 *   ganho máx = prêmio líquido; perda máx = (largura efetiva - prêmio líquido) × 100.
 */
export function simulate(
  ticker: string,
  entradaDate: string,
  opt: OptionRow,
  spotVenc: number,
  protecao: OptionRow | null
): SimOp {
  const useSpread = protecao !== null;

  let resultado: "WIN" | "LOSS";
  let pl: number;
  let pl_pct: number;
  let margem: number;
  let base: {
    estrutura: "NAKED_PUT" | "BULL_PUT_SPREAD";
    strike_protecao?: number;
    premio_protecao?: number;
    premio_liquido?: number;
    perda_maxima?: number;
  } = { estrutura: "NAKED_PUT" };

  if (useSpread) {
    const larguraEfetiva = opt.strike - protecao!.strike; // largura real entre os strikes
    const premioLiquido = opt.premium - protecao!.premium; // crédito recebido líquido
    const perdaMaxima = round2(Math.max(0, (larguraEfetiva - premioLiquido) * CONTRACT_SIZE));
    // Payoff da trava de PUT no vencimento (por ação), depois × lote:
    //   spot >= strike_vendido        → +premioLiquido
    //   strike_protecao < spot < venda → +premioLiquido - (strike_vendido - spot)
    //   spot <= strike_protecao        → +premioLiquido - larguraEfetiva  (= -perda_maxima)
    let payoffAcao: number;
    if (spotVenc >= opt.strike) payoffAcao = premioLiquido;
    else if (spotVenc <= protecao!.strike) payoffAcao = premioLiquido - larguraEfetiva;
    else payoffAcao = premioLiquido - (opt.strike - spotVenc);

    pl = round2(payoffAcao * CONTRACT_SIZE);
    resultado = pl >= 0 ? "WIN" : "LOSS";
    // Margem da trava = risco máximo (capital realmente em jogo).
    margem = perdaMaxima > 0 ? perdaMaxima : round2(larguraEfetiva * CONTRACT_SIZE);
    pl_pct = premioLiquido > 0 ? round1((payoffAcao / premioLiquido) * 100) : 0;
    base = {
      estrutura: "BULL_PUT_SPREAD",
      strike_protecao: round2(protecao!.strike),
      premio_protecao: round2(protecao!.premium),
      premio_liquido: round2(premioLiquido),
      perda_maxima: perdaMaxima,
    };
  } else {
    margem = round2(opt.strike * CONTRACT_SIZE * MARGIN_STRESS_FACTOR);
    if (spotVenc > opt.strike) {
      resultado = "WIN";
      pl = round2(opt.premium * CONTRACT_SIZE);
      pl_pct = 100;
    } else {
      resultado = "LOSS";
      const perda = opt.strike - spotVenc;
      pl = round2((opt.premium - perda) * CONTRACT_SIZE);
      pl_pct = round1((pl / (opt.premium * CONTRACT_SIZE)) * 100);
    }
  }

  return {
    ticker,
    entrada_date: entradaDate,
    expiry_date: opt.due_date,
    strike: opt.strike,
    premio_entrada: round2(opt.premium),
    delta: round2(opt.delta),
    dte: opt.dte,
    spot_vencimento: round2(spotVenc),
    resultado,
    pl,
    pl_pct,
    margem,
    retorno_margem_pct: margem > 0 ? round1((pl / margem) * 100) : 0,
    volume_nao_verificado: true, // volume de PUT não existe no histórico
    ...base,
  };
}

// ── Walk de entradas para uma combinação de filtros ───────────────────────────

interface FilterToggles {
  useIvRank: boolean;
  useM9m21: boolean;
}

function indexOnOrAfter(dates: string[], target: string): number {
  for (let i = 0; i < dates.length; i++) if (dates[i] >= target) return i;
  return -1;
}

/**
 * Percorre os dias aplicando os filtros ligados, respeitando anti-sobreposição
 * (não abre nova operação enquanto há uma pendente). Reutiliza `getChain`
 * (memoizado) para as cadeias de opções.
 */
async function runVariant(
  ticker: string,
  candles: Candle[],
  ind: { vol21: number[]; ivRank: number[]; m9m21: number[] },
  p: BacktestParams,
  toggles: FilterToggles,
  getChain: (date: string) => Promise<OptionRow[] | null>,
  deadline: number
): Promise<SimOp[]> {
  const dates = candles.map((c) => c.date);
  const ops: SimOp[] = [];
  let abertaAteIdx = -1;

  for (let di = 0; di < candles.length; di++) {
    if (di <= abertaAteIdx) continue; // posição aberta → anti-sobreposição
    if (Date.now() > deadline) break;  // orçamento do ativo esgotado

    if (toggles.useIvRank && !(ind.ivRank[di] >= p.iv_rank_min)) continue;
    if (toggles.useM9m21 && !(ind.m9m21[di] >= 1.0)) continue;
    // Filtro de volume: não verificável no histórico → ignorado (flag na op).

    const chain = await getChain(dates[di]);
    if (!chain || chain.length === 0) continue;

    const opt = selectPut(chain, p);
    if (!opt || !opt.due_date) continue;

    const expiryIdx = indexOnOrAfter(dates, opt.due_date);
    if (expiryIdx < 0) continue; // vencimento além dos dados disponíveis

    // Trava (Bull Put Spread): busca a perna de proteção real na mesma cadeia.
    // Se use_spread mas não houver proteção disponível, cai para naked (protecao=null).
    const protecao = p.use_spread ? selectProtective(chain, opt, p.spread_width) : null;

    ops.push(simulate(ticker, dates[di], opt, candles[expiryIdx].close, protecao));
    abertaAteIdx = expiryIdx;
  }
  return ops;
}

// ── Backtest de um ativo (roda as 4 variantes de filtro) ──────────────────────

interface TickerResult {
  ticker: string;
  status: "OK" | "TIMEOUT" | "SEM_DADOS";
  variantes: { todos: SimOp[]; sem_iv: SimOp[]; sem_m9: SimOp[]; nenhum: SimOp[] };
  alertas: string[];
}

async function backtestTicker(client: AxiosInstance, ticker: string, p: BacktestParams): Promise<TickerResult> {
  const tk = ticker.toUpperCase();
  const deadline = Date.now() + PER_TICKER_BUDGET_MS;
  const empty = { todos: [], sem_iv: [], sem_m9: [], nenhum: [] };
  const alertas: string[] = [];

  // 1) Série de preços (1 chamada)
  let candles: Candle[];
  try {
    const { data } = await client.get(`/market/historical/${tk}/1d`, {
      params: { from: p.data_inicio, to: p.data_fim },
      timeout: REQUEST_TIMEOUT_MS,
    });
    candles = extractCandles(data);
  } catch {
    return { ticker: tk, status: "TIMEOUT", variantes: empty, alertas: [`${tk}: sem resposta da API de histórico (TIMEOUT)`] };
  }
  if (candles.length < 22) {
    return { ticker: tk, status: "SEM_DADOS", variantes: empty, alertas: [`${tk}: histórico insuficiente (${candles.length} candles)`] };
  }
  if (candles[0].date > p.data_inicio.slice(0, 10)) {
    alertas.push(`${tk}: dados históricos disponíveis apenas a partir de ${candles[0].date}`);
  }

  const closes = candles.map((c) => c.close);
  const ind = buildIndicators(closes);

  // Cadeia de opções memoizada por data (compartilhada entre as 4 variantes).
  // null = tentou e não há dados; ausente = ainda não buscado.
  const chainMemo = new Map<string, OptionRow[] | null>();
  const getChain = async (date: string): Promise<OptionRow[] | null> => {
    if (chainMemo.has(date)) return chainMemo.get(date)!;
    if (Date.now() > deadline) return null;
    // Limitação #1: se não houver dados na data, tenta até 3 dias anteriores.
    for (let back = 0; back <= MAX_PREV_DAY_RETRIES; back++) {
      const d = fmtDate(new Date(parseDate(date).getTime() - back * DAY_MS));
      try {
        const { data } = await client.get(`/market/historical/options/${tk}/${d}/${d}`, {
          timeout: REQUEST_TIMEOUT_MS,
        });
        const opts = extractOptions(data);
        if (opts.length > 0) {
          chainMemo.set(date, opts);
          return opts;
        }
      } catch {
        // tenta dia anterior
      }
    }
    chainMemo.set(date, null);
    return null;
  };

  const todos = await runVariant(tk, candles, ind, p, { useIvRank: true, useM9m21: p.m9m21_filter }, getChain, deadline);
  const sem_iv = await runVariant(tk, candles, ind, p, { useIvRank: false, useM9m21: p.m9m21_filter }, getChain, deadline);
  const sem_m9 = await runVariant(tk, candles, ind, p, { useIvRank: true, useM9m21: false }, getChain, deadline);
  const nenhum = await runVariant(tk, candles, ind, p, { useIvRank: false, useM9m21: false }, getChain, deadline);

  const status: TickerResult["status"] = Date.now() > deadline ? "TIMEOUT" : "OK";
  if (todos.length > 0 && todos.length < 4) {
    alertas.push(`${tk}: apenas ${todos.length} operações no período (histórico insuficiente)`);
  }
  return { ticker: tk, status, variantes: { todos, sem_iv, sem_m9, nenhum }, alertas };
}

// ── Agregações ────────────────────────────────────────────────────────────────

function aggVariant(ops: SimOp[]): VariantAgg {
  const wins = ops.filter((o) => o.resultado === "WIN").length;
  const pl = ops.reduce((s, o) => s + o.pl, 0);
  return {
    operacoes: ops.length,
    win_rate_pct: ops.length ? round1((wins / ops.length) * 100) : 0,
    pl_total: round2(pl),
  };
}

function streaks(ops: SimOp[]): { wins: number; losses: number } {
  const ordered = [...ops].sort((a, b) => a.entrada_date.localeCompare(b.entrada_date));
  let maxW = 0, maxL = 0, curW = 0, curL = 0;
  for (const o of ordered) {
    if (o.resultado === "WIN") { curW++; curL = 0; maxW = Math.max(maxW, curW); }
    else { curL++; curW = 0; maxL = Math.max(maxL, curL); }
  }
  return { wins: maxW, losses: maxL };
}

// ── Normalização de parâmetros ────────────────────────────────────────────────

function num(v: unknown, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

export function normalizarBacktestParams(a: Record<string, unknown>): { params: BacktestParams; avisoPeriodo?: string } {
  const tickers =
    Array.isArray(a.tickers) && a.tickers.length ? a.tickers.map((t) => String(t).toUpperCase()) : [...WHITELIST_24];

  const hoje = new Date();
  const doisAnosAtras = new Date(hoje.getTime() - MAX_PERIOD_DAYS * DAY_MS);
  let data_fim = typeof a.data_fim === "string" && a.data_fim ? a.data_fim.slice(0, 10) : fmtDate(hoje);
  let data_inicio =
    typeof a.data_inicio === "string" && a.data_inicio ? a.data_inicio.slice(0, 10) : fmtDate(doisAnosAtras);

  // Limitação #5: período máximo de 2 anos.
  let avisoPeriodo: string | undefined;
  const spanDays = (parseDate(data_fim).getTime() - parseDate(data_inicio).getTime()) / DAY_MS;
  if (spanDays > MAX_PERIOD_DAYS) {
    data_inicio = fmtDate(new Date(parseDate(data_fim).getTime() - MAX_PERIOD_DAYS * DAY_MS));
    avisoPeriodo = "Período limitado a 2 anos para evitar timeout. Ajustando data_inicio.";
  }

  const periodo_dias = Math.round((parseDate(data_fim).getTime() - parseDate(data_inicio).getTime()) / DAY_MS);

  return {
    params: {
      tickers,
      data_inicio,
      data_fim,
      delta_min: num(a.delta_min, -0.3),
      delta_max: num(a.delta_max, -0.15),
      dte_min: Math.round(num(a.dte_min, 15)),
      dte_max: Math.round(num(a.dte_max, 30)),
      iv_rank_min: Math.round(num(a.iv_rank_min, 50)),
      m9m21_filter: a.m9m21_filter === undefined ? true : Boolean(a.m9m21_filter),
      use_spread: a.use_spread === undefined ? false : Boolean(a.use_spread),
      spread_width: Math.max(0.01, num(a.spread_width, 3.0)),
      periodo_dias,
    },
    avisoPeriodo,
  };
}

// ── Orquestração principal ────────────────────────────────────────────────────

export async function getBacktestProtocolo2(client: AxiosInstance, args: Record<string, unknown>): Promise<BacktestResult> {
  const start = Date.now();
  const { params, avisoPeriodo } = normalizarBacktestParams(args);

  // Cache de 24h por parâmetros.
  const cacheKey = `backtest_${params.tickers.join(",")}_${params.data_inicio}_${params.data_fim}_${params.delta_min}_${params.delta_max}_${params.dte_min}_${params.dte_max}_${params.iv_rank_min}_${params.m9m21_filter}_${params.use_spread}_${params.spread_width}`;
  const cached = backtestCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return {
      ...cached.data,
      resumo_geral: { ...cached.data.resumo_geral, cache_hit: true, tempo_execucao_ms: Date.now() - start },
    };
  }

  // Lotes de 3 ativos com 500ms entre lotes (mais conservador que iv_rank_bulk).
  const resultados = await batchWithLimit(params.tickers, (tk) => backtestTicker(client, tk, params), 3, 500);

  // Consolida operações (variante "todos os filtros" é a oficial).
  const opsTodos: SimOp[] = [];
  const opsSemIv: SimOp[] = [];
  const opsSemM9: SimOp[] = [];
  const opsNenhum: SimOp[] = [];
  const alertas: string[] = [];
  if (avisoPeriodo) alertas.push(avisoPeriodo);

  const por_ativo: BacktestResult["por_ativo"] = [];

  for (const r of resultados) {
    opsTodos.push(...r.variantes.todos);
    opsSemIv.push(...r.variantes.sem_iv);
    opsSemM9.push(...r.variantes.sem_m9);
    opsNenhum.push(...r.variantes.nenhum);
    alertas.push(...r.alertas);

    const ops = r.variantes.todos;
    const wins = ops.filter((o) => o.resultado === "WIN").length;
    const melhor = ops.reduce<SimOp | null>((b, o) => (!b || o.pl > b.pl ? o : b), null);
    const pior = ops.reduce<SimOp | null>((b, o) => (!b || o.pl < b.pl ? o : b), null);
    por_ativo.push({
      ticker: r.ticker,
      operacoes: ops.length,
      wins,
      losses: ops.length - wins,
      win_rate_pct: ops.length ? round1((wins / ops.length) * 100) : 0,
      pl_total: round2(ops.reduce((s, o) => s + o.pl, 0)),
      melhor_op: melhor ? { data: melhor.entrada_date, pl: melhor.pl } : null,
      pior_op: pior ? { data: pior.entrada_date, pl: pior.pl } : null,
    });
  }
  por_ativo.sort((a, b) => b.pl_total - a.pl_total);

  // resumo_geral
  const wins = opsTodos.filter((o) => o.resultado === "WIN").length;
  const losses = opsTodos.length - wins;
  const plTotal = opsTodos.reduce((s, o) => s + o.pl, 0);
  const retMargem = opsTodos.length
    ? opsTodos.reduce((s, o) => s + o.retorno_margem_pct, 0) / opsTodos.length
    : 0;
  const st = streaks(opsTodos);

  // por_mes (agrupado pelo mês de ENTRADA) + curva de capital (pelo VENCIMENTO)
  const porMesMap = new Map<string, { ops: number; wins: number; losses: number; pl: number }>();
  for (const o of opsTodos) {
    const mes = o.entrada_date.slice(0, 7);
    const e = porMesMap.get(mes) ?? { ops: 0, wins: 0, losses: 0, pl: 0 };
    e.ops++;
    if (o.resultado === "WIN") e.wins++; else e.losses++;
    e.pl += o.pl;
    porMesMap.set(mes, e);
  }
  let acumMes = 0;
  const por_mes = [...porMesMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([mes, e]) => {
      acumMes += e.pl;
      return {
        mes,
        operacoes: e.ops,
        wins: e.wins,
        losses: e.losses,
        win_rate_pct: e.ops ? round1((e.wins / e.ops) * 100) : 0,
        pl_mes: round2(e.pl),
        capital_acumulado: round2(acumMes),
      };
    });

  let acum = 0;
  const curva_capital = [...opsTodos]
    .sort((a, b) => a.expiry_date.localeCompare(b.expiry_date))
    .map((o) => {
      acum += o.pl;
      return { data: o.expiry_date, pl_acumulado: round2(acum) };
    });

  const result: BacktestResult = {
    parametros: params,
    resumo_geral: {
      total_operacoes: opsTodos.length,
      wins,
      losses,
      win_rate_pct: opsTodos.length ? round1((wins / opsTodos.length) * 100) : 0,
      pl_total_estimado: round2(plTotal),
      retorno_medio_por_op: opsTodos.length ? round2(plTotal / opsTodos.length) : 0,
      retorno_medio_sobre_margem_pct: round1(retMargem),
      maior_sequencia_wins: st.wins,
      maior_sequencia_losses: st.losses,
      cache_hit: false,
      tempo_execucao_ms: Date.now() - start,
    },
    comparativo_filtros: {
      com_todos_filtros: aggVariant(opsTodos),
      sem_iv_rank: aggVariant(opsSemIv),
      sem_m9m21: aggVariant(opsSemM9),
      sem_nenhum_filtro: aggVariant(opsNenhum),
    },
    por_ativo,
    por_mes,
    curva_capital,
    alertas,
  };

  backtestCache.set(cacheKey, { data: result, timestamp: Date.now() });
  return result;
}

// ===========================================================================
// Backtest QUANTITATIVO — venda contínua de PUTs (Short Put / "The Wheel")
//
// Simula mecanicamente a venda recorrente de PUTs OTM sobre a série histórica
// do ativo, num ciclo mensal (~21 pregões), e calcula métricas de risco de
// nível institucional: retorno, win rate, max drawdown, profit factor e a
// curva de capital. Ferramenta 34 (get_backtest_quantitativo).
//
// Premissas (simplificadas, declaradas):
//   • Strike da PUT vendida = preço_atual × (1 − alvo_otm_pct)  [proxy de ~Delta 30].
//   • Prêmio recebido (caixa) = Strike × premio_estimado_pct × 100  (1 lote padrão).
//   • Margem retida pela corretora = 20% do nocional do Strike (Strike × 100 × 0.20).
//   • No vencimento (após ~21 pregões):
//       spot ≥ Strike → PUT vira pó: lucro integral do prêmio (Win).
//       spot < Strike → exercício: prejuízo = (Strike − spot) × 100, abatido do
//                       prêmio já recebido (Loss).  P/L_op = prêmio − (Strike−spot)×100.
// ===========================================================================

/** Cache dedicado de 4h (TTL diferente do backtest do Protocolo 2). */
const QUANT_CACHE_TTL_MS = 4 * 60 * 60 * 1000;
const quantCache = new Map<string, { data: QuantBacktestResult; timestamp: number }>();

/** Limpa o cache do backtest quantitativo (usado em testes). */
export function clearQuantBacktestCache(): void {
  quantCache.clear();
}

const QUANT_CICLO_PREGOES = 21;     // ~1 vencimento mensal de opções
const QUANT_MARGEM_PCT = 0.20;      // corretora retém 20% do nocional do strike
const QUANT_REQUEST_TIMEOUT_MS = 15_000;

export interface QuantBacktestParams {
  ticker: string;
  capital_inicial: number;
  dias_historico: number;
  alvo_otm_pct: number;
  premio_estimado_pct: number;
  alocacao_margem_pct: number;
}

export interface QuantOperacao {
  ciclo: number;
  data_entrada: string;
  data_saida: string;
  spot_entrada: number;
  strike: number;
  quantidade: number;     // nº de opções vendidas (múltiplo de 100)
  margem_alocada: number; // margem de garantia retida na abertura
  premio: number;
  spot_saida: number;
  resultado: "WIN" | "LOSS";
  pl: number;
  caixa_apos: number;
}

export interface QuantBacktestResult {
  ticker: string;
  parametros: QuantBacktestParams;
  capital_final: number;
  retorno_total_pct: number;
  win_rate_pct: number;
  max_drawdown_pct: number;
  profit_factor: number | null;
  operacoes_realizadas: number;
  wins: number;
  losses: number;
  curva_capital: Array<{ ciclo: number; data: string; capital: number }>;
  operacoes: QuantOperacao[];
  cache_hit: boolean;
  alertas: string[];
}

/** Normaliza e aplica defaults aos parâmetros da ferramenta. */
export function normalizarQuantParams(a: Record<string, unknown>): QuantBacktestParams {
  const n = (v: unknown, def: number): number => {
    const x = Number(v);
    return Number.isFinite(x) ? x : def;
  };
  return {
    ticker: String(a.ticker ?? "").toUpperCase(),
    capital_inicial: Math.max(1, n(a.capital_inicial, 50_000)),
    // Teto de 2 anos para evitar timeout (mesma política do outro backtest).
    dias_historico: Math.min(MAX_PERIOD_DAYS, Math.max(60, Math.round(n(a.dias_historico, 730)))),
    alvo_otm_pct: Math.min(0.5, Math.max(0, n(a.alvo_otm_pct, 0.05))),
    premio_estimado_pct: Math.min(0.5, Math.max(0.0001, n(a.premio_estimado_pct, 0.02))),
    // Fração do caixa livre usada como margem de garantia na abertura (0–1).
    // Limitada a 1.0 (não faz sentido alocar mais que o caixa disponível).
    alocacao_margem_pct: Math.min(1, Math.max(0.01, n(a.alocacao_margem_pct, 0.20))),
  };
}

/**
 * Executa o backtest quantitativo de venda contínua de PUTs.
 * Lança Error com mensagem clara em falha de dados; o handler do index.ts
 * converte em resposta de erro do MCP.
 */
export async function runQuantBacktest(
  client: AxiosInstance,
  args: Record<string, unknown>
): Promise<QuantBacktestResult> {
  const p = normalizarQuantParams(args);
  if (!p.ticker) {
    throw new Error("Parâmetro 'ticker' é obrigatório (ex: PETR4).");
  }

  // Cache de 4h por (ticker + parâmetros).
  const cacheKey = `quant_${p.ticker}_${p.dias_historico}_${p.alvo_otm_pct}_${p.premio_estimado_pct}_${p.capital_inicial}_${p.alocacao_margem_pct}`;
  const cached = quantCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < QUANT_CACHE_TTL_MS) {
    return { ...cached.data, cache_hit: true };
  }

  // 1) DADOS — série de fechamentos via OpLab, com try/catch e mensagem clara.
  const to = new Date();
  const from = new Date(to.getTime() - p.dias_historico * DAY_MS);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  let candles: Candle[];
  try {
    const { data } = await client.get(`/market/historical/${p.ticker}/1d`, {
      params: { from: fmt(from), to: fmt(to) },
      timeout: QUANT_REQUEST_TIMEOUT_MS,
    });
    candles = extractCandles(data);
  } catch (e) {
    const status = (e as { response?: { status?: number } })?.response?.status;
    throw new Error(
      `Falha ao buscar histórico de ${p.ticker} na OpLab${status ? ` (HTTP ${status})` : ""}. ` +
        `Verifique o código do ativo e tente novamente.`
    );
  }
  if (candles.length < QUANT_CICLO_PREGOES + 1) {
    throw new Error(
      `Histórico insuficiente para ${p.ticker}: ${candles.length} pregões (mínimo ${QUANT_CICLO_PREGOES + 1}).`
    );
  }

  // 2) SIMULAÇÃO MECÂNICA — loop temporal em ciclos de 21 pregões.
  let caixa = p.capital_inicial;
  const operacoes: QuantOperacao[] = [];
  const curva_capital: Array<{ ciclo: number; data: string; capital: number }> = [
    { ciclo: 0, data: candles[0].date, capital: round2(caixa) },
  ];
  // Para o max drawdown e o profit factor:
  let pico = caixa;          // maior capital já atingido (topo)
  let maxDrawdown = 0;       // maior queda percentual topo→fundo
  let somaLucros = 0;        // Σ |P/L| das operações vencedoras
  let somaPrejuizos = 0;     // Σ |P/L| das operações perdedoras
  const alertas: string[] = [];

  let ciclo = 0;
  for (let i = 0; i + QUANT_CICLO_PREGOES < candles.length; i += QUANT_CICLO_PREGOES) {
    ciclo++;
    const entrada = candles[i];
    const saida = candles[i + QUANT_CICLO_PREGOES];

    // ENTRADA — vende a PUT OTM com DIMENSIONAMENTO DINÂMICO de posição.
    const strike = entrada.close * (1 - p.alvo_otm_pct);

    // Position sizing: aloca uma fração do CAIXA LIVRE atual como margem (juros
    // compostos — a base cresce/encolhe com o resultado acumulado). A corretora
    // exige 20% do strike por opção como garantia. A quantidade é arredondada
    // para baixo ao múltiplo de 100 (lote padrão da B3).
    const margemPorOpcao = strike * QUANT_MARGEM_PCT; // garantia exigida por opção
    let quantidade = 0;
    if (strike > 0 && margemPorOpcao > 0 && caixa > 0) {
      const margemDisponivel = caixa * p.alocacao_margem_pct;
      const qtdMaxima = Math.floor(margemDisponivel / margemPorOpcao);
      quantidade = Math.floor(qtdMaxima / CONTRACT_SIZE) * CONTRACT_SIZE; // múltiplo de 100
    }

    // Capital insuficiente para ao menos 1 lote padrão → não entra.
    if (quantidade < CONTRACT_SIZE) {
      alertas.push(
        `Ciclo ${ciclo} (${entrada.date}): caixa R$${round2(caixa)} aloca margem ` +
          `R$${round2(caixa * p.alocacao_margem_pct)} — insuficiente para 1 lote ` +
          `(margem/opção R$${round2(margemPorOpcao)}). Operação pulada.`
      );
      continue;
    }

    const margemAlocada = quantidade * margemPorOpcao; // garantia efetivamente retida
    // Prêmio recebido escala com a quantidade vendida.
    const premio = strike * p.premio_estimado_pct * quantidade;

    // Recebe o prêmio em caixa no momento da venda.
    caixa += premio;

    // VENCIMENTO — liquida no preço de saída (após ~21 pregões).
    let resultado: "WIN" | "LOSS";
    let pl: number;
    if (saida.close >= strike) {
      // PUT vira pó: lucro integral do prêmio.
      resultado = "WIN";
      pl = round2(premio);
      somaLucros += premio;
    } else {
      // Exercício: prejuízo proporcional à quantidade vendida, abatido do prêmio.
      resultado = "LOSS";
      const prejuizoExercicio = (strike - saida.close) * quantidade;
      caixa -= prejuizoExercicio;
      pl = round2(premio - prejuizoExercicio); // P/L líquido da operação
      somaPrejuizos += Math.abs(pl); // |perda líquida|
    }

    operacoes.push({
      ciclo,
      data_entrada: entrada.date,
      data_saida: saida.date,
      spot_entrada: round2(entrada.close),
      strike: round2(strike),
      quantidade,
      margem_alocada: round2(margemAlocada),
      premio: round2(premio),
      spot_saida: round2(saida.close),
      resultado,
      pl,
      caixa_apos: round2(caixa),
    });
    curva_capital.push({ ciclo, data: saida.date, capital: round2(caixa) });

    // MAX DRAWDOWN — atualiza topo e mede a maior queda percentual topo→fundo.
    if (caixa > pico) pico = caixa;
    if (pico > 0) {
      const dd = (pico - caixa) / pico; // fração do topo perdida
      if (dd > maxDrawdown) maxDrawdown = dd;
    }
  }

  // 3) MÉTRICAS QUANTITATIVAS
  const wins = operacoes.filter((o) => o.resultado === "WIN").length;
  const losses = operacoes.length - wins;
  const capital_final = round2(caixa);
  const retorno_total_pct = round2(((caixa / p.capital_inicial) - 1) * 100);
  const win_rate_pct = operacoes.length ? round1((wins / operacoes.length) * 100) : 0;
  const max_drawdown_pct = round2(maxDrawdown * 100);
  // Profit factor = Σ lucros / Σ prejuízos. null quando não houve prejuízo
  // (indefinido matematicamente; sinaliza "sem perdas" em vez de forçar ∞).
  const profit_factor = somaPrejuizos > 0 ? round2(somaLucros / somaPrejuizos) : null;

  if (operacoes.length === 0) {
    alertas.push("Nenhuma operação realizada — histórico curto ou margem insuficiente para o capital informado.");
  }

  const result: QuantBacktestResult = {
    ticker: p.ticker,
    parametros: p,
    capital_final,
    retorno_total_pct,
    win_rate_pct,
    max_drawdown_pct,
    profit_factor,
    operacoes_realizadas: operacoes.length,
    wins,
    losses,
    curva_capital,
    operacoes,
    cache_hit: false,
    alertas,
  };

  quantCache.set(cacheKey, { data: result, timestamp: Date.now() });
  return result;
}
