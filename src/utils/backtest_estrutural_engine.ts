// ─────────────────────────────────────────────────────────────────────────────
// backtest_estrutural_engine.ts — get_backtest_estrutural (Ferramenta #3)
//
// Responde EMPIRICAMENTE: filtrar entradas pela estrutura de preço melhora o win
// rate sobre o baseline? Se NÃO melhorar ≥5pp, a análise estrutural é narrativa
// (descreve, não prevê) — e a #2 (projeção condicionada) NÃO deve ser construída.
//
// ⚠️ REGRA MAIS IMPORTANTE — ZERO LOOK-AHEAD: em cada data de entrada, o estado
// estrutural é reconstruído com `classificarEstrutura(candles.slice(0, di+1))` —
// só candles ATÉ a entrada. Os indicadores (IV Rank, M9/M21) usam buildIndicators,
// que também é point-in-time. O único dado futuro é o SPOT no vencimento, usado
// apenas para apurar o RESULTADO — nunca para decidir a entrada nem os filtros.
//
// Desenho experimental: abre-se o conjunto BASELINE de entradas (uma por ciclo,
// anti-sobreposição) e cada coorte é um SUBCONJUNTO do baseline que satisfaz o
// filtro — mesma janela de oportunidades, comparação justa. Determinístico.
// ─────────────────────────────────────────────────────────────────────────────

import { AxiosInstance } from "axios";
import { WHITELIST_24, batchWithLimit } from "./iv_calculator.js";
import { parseCandlesEstrutura, classificarEstrutura } from "./estrutura_engine.js";
import { extractOptions, selectPut, selectProtective, simulate, buildIndicators, BacktestParams, OptionRow } from "./backtest_engine.js";

const REQUEST_TIMEOUT_MS = 10_000;
const PER_TICKER_BUDGET_MS = 14_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;
const MAX_PREV_DAY_RETRIES = 3;
const MIN_CANDLES_ESTRUTURA = 30;
const N_MIN_COORTE = 30;
const LIFT_MIN_PP = 5;

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

function toDateStr(t: number): string {
  const ms = t < 1e12 ? t * 1000 : t;
  return new Date(ms).toISOString().slice(0, 10);
}
function fmtDate(d: Date): string { return d.toISOString().slice(0, 10); }
function indexOnOrAfter(dates: string[], target: string): number {
  for (let i = 0; i < dates.length; i++) if (dates[i] >= target) return i;
  return -1;
}

interface EntryOp {
  ticker: string;
  date: string;
  // flags point-in-time (só dados até a entrada)
  estrutura_tendencia: string;
  fase_atual: string;
  rompeu_alta: boolean;
  volume_confirma: boolean;
  transicao_detectada: boolean;
  transicao_direcao: string | null;
  m9m21_ratio: number | null;
  iv_rank: number; // NaN se ainda sem janela
  // detalhe da operação (para auditoria/reconstrução independente via incluir_operacoes)
  strike: number;
  premio_entrada: number;
  delta: number;
  dte: number;
  expiry_date: string;
  use_spread: boolean;
  strike_protecao: number | null;
  premio_protecao: number | null;
  spot_vencimento: number;
  // resultado (usa spot futuro APENAS para apurar, nunca para decidir)
  resultado: "WIN" | "LOSS";
  pl: number;
}

const estruturalCache = new Map<string, { data: unknown; timestamp: number }>();
export function clearBacktestEstruturalCache(): void { estruturalCache.clear(); }

interface EstruturalParams {
  tickers: string[];
  lookback_meses: number;
  dte_alvo: number;
  delta_alvo: number;
  use_spread: boolean;
  incluir_operacoes: boolean;
}

function normalizar(a: Record<string, unknown>): EstruturalParams {
  const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    tickers: Array.isArray(a.tickers) && a.tickers.length ? a.tickers.map((t) => String(t).toUpperCase()) : [...WHITELIST_24],
    lookback_meses: Math.min(24, Math.max(6, Math.round(num(a.lookback_meses, 24)))),
    dte_alvo: Math.max(7, Math.round(num(a.dte_alvo, 25))),
    delta_alvo: num(a.delta_alvo, -0.25),
    use_spread: a.use_spread === undefined ? true : Boolean(a.use_spread),
    incluir_operacoes: Boolean(a.incluir_operacoes),
  };
}

/** BacktestParams sintético para reusar selectPut/selectProtective/simulate. */
function toBacktestParams(p: EstruturalParams): BacktestParams {
  return {
    tickers: p.tickers,
    data_inicio: "", data_fim: "",
    delta_min: p.delta_alvo - 0.08,
    delta_max: p.delta_alvo + 0.08,
    dte_min: Math.max(1, p.dte_alvo - 8),
    dte_max: p.dte_alvo + 8,
    iv_rank_min: 0, m9m21_filter: false,
    use_spread: p.use_spread, spread_width: 3.0,
    periodo_dias: 0,
  };
}

async function backtestTickerEstrutural(client: AxiosInstance, ticker: string, p: EstruturalParams): Promise<{ ops: EntryOp[]; alertas: string[] }> {
  const tk = ticker.toUpperCase();
  const deadline = Date.now() + PER_TICKER_BUDGET_MS;
  const alertas: string[] = [];
  const bp = toBacktestParams(p);

  const to = new Date();
  const from = new Date(to.getTime() - Math.round(p.lookback_meses * 30.4 + 40) * DAY_MS); // +40d de warm-up p/ estrutura

  let raw: unknown;
  try {
    raw = (await client.get(`/market/historical/${tk}/1d`, { params: { from: fmtDate(from), to: fmtDate(to) }, timeout: REQUEST_TIMEOUT_MS })).data;
  } catch {
    return { ops: [], alertas: [`${tk}: sem resposta da API de histórico`] };
  }
  const candles = parseCandlesEstrutura(raw);
  if (candles.length < MIN_CANDLES_ESTRUTURA + 5) return { ops: [], alertas: [`${tk}: histórico insuficiente (${candles.length} candles)`] };

  const dates = candles.map((c) => toDateStr(c.time));
  const closes = candles.map((c) => c.close);
  const ind = buildIndicators(closes); // ivRank[], m9m21[] — point-in-time

  // cadeia de opções memoizada por data (com retry de até 3 dias anteriores)
  const chainMemo = new Map<string, OptionRow[] | null>();
  const getChain = async (date: string): Promise<OptionRow[] | null> => {
    if (chainMemo.has(date)) return chainMemo.get(date)!;
    if (Date.now() > deadline) return null;
    for (let back = 0; back <= MAX_PREV_DAY_RETRIES; back++) {
      const d = fmtDate(new Date(Date.parse(`${date}T00:00:00.000Z`) - back * DAY_MS));
      try {
        const { data } = await client.get(`/market/historical/options/${tk}/${d}/${d}`, { timeout: REQUEST_TIMEOUT_MS });
        const opts = extractOptions(data);
        if (opts.length > 0) { chainMemo.set(date, opts); return opts; }
      } catch { /* tenta dia anterior */ }
    }
    chainMemo.set(date, null);
    return null;
  };

  const ops: EntryOp[] = [];
  let abertaAteIdx = MIN_CANDLES_ESTRUTURA - 1; // só entra com ≥30 candles de estrutura

  for (let di = MIN_CANDLES_ESTRUTURA; di < candles.length; di++) {
    if (di <= abertaAteIdx) continue;         // anti-sobreposição
    if (Date.now() > deadline) break;

    const chain = await getChain(dates[di]);
    if (!chain || chain.length === 0) continue;
    const opt = selectPut(chain, bp);
    if (!opt || !opt.due_date) continue;
    const expiryIdx = indexOnOrAfter(dates, opt.due_date);
    if (expiryIdx < 0) continue;              // vencimento além dos dados

    // ── estado estrutural reconstruído SÓ com candles até a entrada ──
    const est = classificarEstrutura(candles.slice(0, di + 1));
    if (!est) { abertaAteIdx = expiryIdx; continue; }

    const protecao = p.use_spread ? selectProtective(chain, opt, bp.spread_width) : null;
    const sim = simulate(tk, dates[di], opt, candles[expiryIdx].close, protecao);

    ops.push({
      ticker: tk,
      date: dates[di],
      estrutura_tendencia: est.estrutura_tendencia,
      fase_atual: est.fase_atual,
      rompeu_alta: est.rompeu_alta,
      volume_confirma: est.volume_confirma,
      transicao_detectada: est.transicao_detectada,
      transicao_direcao: est.transicao_direcao,
      m9m21_ratio: est.m9m21_ratio,
      iv_rank: ind.ivRank[di],
      strike: sim.strike,
      premio_entrada: sim.premio_entrada,
      delta: sim.delta,
      dte: sim.dte,
      expiry_date: sim.expiry_date,
      use_spread: protecao !== null,
      strike_protecao: (sim as unknown as { strike_protecao?: number }).strike_protecao ?? null,
      premio_protecao: (sim as unknown as { premio_protecao?: number }).premio_protecao ?? null,
      spot_vencimento: sim.spot_vencimento,
      resultado: sim.resultado,
      pl: sim.pl,
    });
    abertaAteIdx = expiryIdx;
  }

  if (Date.now() > deadline) alertas.push(`${tk}: orçamento de tempo esgotado — resultado parcial (${ops.length} ops)`);
  return { ops, alertas };
}

interface Coorte { nome: string; n_operacoes: number; win_rate_pct: number; pl_total: number; pl_medio: number; pl_desvio_padrao: number; sharpe_simplificado: number; }

function statsCoorte(nome: string, ops: EntryOp[]): Coorte {
  const n = ops.length;
  const wins = ops.filter((o) => o.resultado === "WIN").length;
  const pls = ops.map((o) => o.pl);
  const pl_total = pls.reduce((s, x) => s + x, 0);
  const pl_medio = n ? pl_total / n : 0;
  const variance = n > 1 ? pls.reduce((s, x) => s + (x - pl_medio) ** 2, 0) / (n - 1) : 0;
  const sd = Math.sqrt(variance);
  return {
    nome, n_operacoes: n,
    win_rate_pct: n ? round1((wins / n) * 100) : 0,
    pl_total: round2(pl_total),
    pl_medio: round2(pl_medio),
    pl_desvio_padrao: round2(sd),
    sharpe_simplificado: sd > 0 ? round2(pl_medio / sd) : 0,
  };
}

export async function getBacktestEstrutural(client: AxiosInstance, args: Record<string, unknown>): Promise<unknown> {
  const p = normalizar(args);
  const cacheKey = `estrut_${p.tickers.join(",")}_${p.lookback_meses}_${p.dte_alvo}_${p.delta_alvo}_${p.use_spread}`;
  const cached = estruturalCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) return cached.data;

  const resultados = await batchWithLimit(p.tickers, (tk) => backtestTickerEstrutural(client, tk, p), 3, 400);
  const all: EntryOp[] = [];
  const alertas: string[] = [];
  for (const r of resultados) { all.push(...r.ops); alertas.push(...r.alertas); }

  if (all.length === 0) {
    return { erro: "DADOS_INCOMPLETOS", motivo: "nenhuma operação simulada (histórico/cadeia de opções indisponível)", alertas };
  }

  // ── Coortes ──
  const f = {
    baseline: all,
    apenas_iv: all.filter((o) => isFinite(o.iv_rank) && o.iv_rank > 50),
    apenas_m9m21: all.filter((o) => o.m9m21_ratio !== null && o.m9m21_ratio > 1.0),
    apenas_alta_estrutural: all.filter((o) => o.estrutura_tendencia === "ALTA_ESTRUTURAL"),
    alta_estrutural_e_iv: all.filter((o) => o.estrutura_tendencia === "ALTA_ESTRUTURAL" && isFinite(o.iv_rank) && o.iv_rank > 50),
    apenas_transicao: all.filter((o) => o.transicao_detectada && o.transicao_direcao === "ALTA"),
    rompimento_com_volume: all.filter((o) => o.rompeu_alta && o.volume_confirma),
    full_stack: all.filter((o) => isFinite(o.iv_rank) && o.iv_rank > 50 && o.estrutura_tendencia === "ALTA_ESTRUTURAL" && o.m9m21_ratio !== null && o.m9m21_ratio > 1.0),
  };
  const coortes: Coorte[] = Object.entries(f).map(([nome, ops]) => statsCoorte(nome, ops));

  // ── Conclusão ──
  const baseline = coortes.find((c) => c.nome === "baseline")!;
  const candidatas = coortes.filter((c) => c.nome !== "baseline" && c.n_operacoes >= N_MIN_COORTE);
  let melhor_coorte: string | null = null;
  let lift_vs_baseline_pp: number | null = null;
  let amostra_suficiente = false;
  let veredito: string;

  if (candidatas.length === 0) {
    veredito = "AMOSTRA_INSUFICIENTE";
    // reporta a de maior n para transparência, mesmo abaixo do mínimo
    const maiorN = coortes.filter((c) => c.nome !== "baseline").sort((a, b) => b.n_operacoes - a.n_operacoes)[0];
    melhor_coorte = maiorN ? maiorN.nome : null;
  } else {
    amostra_suficiente = true;
    const vencedora = [...candidatas].sort((a, b) => (b.win_rate_pct - a.win_rate_pct) || (b.n_operacoes - a.n_operacoes))[0];
    melhor_coorte = vencedora.nome;
    lift_vs_baseline_pp = round1(vencedora.win_rate_pct - baseline.win_rate_pct);
    veredito = lift_vs_baseline_pp >= LIFT_MIN_PP ? "ESTRUTURA_TEM_EDGE" : "ESTRUTURA_SEM_EDGE";
  }

  // ── por_ticker (baseline) ──
  const porTickerMap = new Map<string, EntryOp[]>();
  for (const o of all) { const arr = porTickerMap.get(o.ticker) ?? []; arr.push(o); porTickerMap.set(o.ticker, arr); }
  const por_ticker = [...porTickerMap.entries()].map(([ticker, ops]) => {
    const wins = ops.filter((o) => o.resultado === "WIN").length;
    return { ticker, n_operacoes: ops.length, win_rate_pct: ops.length ? round1((wins / ops.length) * 100) : 0, pl_total: round2(ops.reduce((s, o) => s + o.pl, 0)) };
  }).sort((a, b) => b.pl_total - a.pl_total);

  // ── operações individuais (opt-in) — para auditoria/reconstrução independente ──
  // Default OFF: sem mudança no output existente. Cada op traz TODOS os inputs da
  // decisão de entrada + o resultado, para reconstrução por scripts/backtest_oracle.py.
  const operacoes = p.incluir_operacoes
    ? all.map((o) => ({
        ticker: o.ticker, entrada_date: o.date, expiry_date: o.expiry_date,
        strike: o.strike, premio_entrada: o.premio_entrada, delta: o.delta, dte: o.dte,
        use_spread: o.use_spread, strike_protecao: o.strike_protecao, premio_protecao: o.premio_protecao,
        spot_vencimento: o.spot_vencimento, resultado: o.resultado, pl: o.pl,
        // flags point-in-time (só dados até a entrada) — para checar a decisão
        estrutura_tendencia: o.estrutura_tendencia, iv_rank: isFinite(o.iv_rank) ? round1(o.iv_rank) : null,
        m9m21_ratio: o.m9m21_ratio,
      }))
    : undefined;

  const hoje = new Date();
  const inicio = new Date(hoje.getTime() - Math.round(p.lookback_meses * 30.4) * DAY_MS);
  const result = {
    periodo: `${fmtDate(inicio)} a ${fmtDate(hoje)} (~${p.lookback_meses} meses)`,
    tickers_analisados: [...porTickerMap.keys()],
    parametros: { dte_alvo: p.dte_alvo, delta_alvo: p.delta_alvo, use_spread: p.use_spread, n_min_coorte: N_MIN_COORTE, lift_min_pp: LIFT_MIN_PP },
    coortes,
    conclusao: { melhor_coorte, lift_vs_baseline_pp, amostra_suficiente, veredito },
    por_ticker,
    ...(operacoes ? { operacoes } : {}),
    alertas,
    snapshot_timestamp: new Date().toISOString(),
    base_calculo: "Backtest determinístico sobre OHLC + cadeia de opções histórica. ZERO look-ahead: estrutura e indicadores reconstruídos só com dados até a entrada. Coortes = subconjuntos do mesmo baseline. Não é sinal de compra/venda.",
    nota_metodologica: "Win rate alto com desvio-padrão alto NÃO é edge. Coorte com n<30 não declara edge. Lift <5pp ⇒ ESTRUTURA_SEM_EDGE (não justifica a complexidade da #2).",
  };

  estruturalCache.set(cacheKey, { data: result, timestamp: Date.now() });
  return result;
}
