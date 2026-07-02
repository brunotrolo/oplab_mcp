// ─────────────────────────────────────────────────────────────────────────────
// manejo_engine.ts — Motor de Manejo/Rolagem ATM/ITM — v2 (7 ajustes)
//
// PRINCÍPIOS (spec v2):
//  • Todo VALOR (prêmio, crédito, custo, resultado, risco) é calculado pelo CLOSE.
//    bid/ask/volume aparecem SÓ como referência de liquidez — nunca entram na conta.
//    Roda a qualquer horário; execução é validada no book do pregão seguinte.
//  • O motor NÃO gerencia patrimônio: sem colchão, sem concentração, sem % de
//    patrimônio. Entrega números crus (R$). Decisão de portfólio é do operador.
//  • Nunca inventa: campo sem CLOSE real ⇒ "INDISPONÍVEL", nunca estimado.
//
// Ajustes: (1) base CLOSE  (2) prioriza vencimentos MENSAIS  (3) TROCA_TICKER
// (4) N pernas com quantidades assimétricas  (5) sem patrimônio  (6) desembolso
// máximo + gamma líquido + alerta de risco de cauda  (7) alerta IV vs realizada.
// ─────────────────────────────────────────────────────────────────────────────

import { AxiosInstance } from "axios";
import { getIVRankHistorico, getIVRankBulk, WHITELIST_24 } from "./iv_calculator.js";

const REQUEST_TIMEOUT_MS = 25_000;
const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
const pct1 = (n: number) => Math.round(n * 1000) / 10;

// ── Tipos ─────────────────────────────────────────────────────────────────────

export interface PernaInput { option_ticker: string; side: "VENDA" | "COMPRA"; quantity: number; entry_price: number; }

export interface ManejoParams {
  ticker: string;
  legs: PernaInput[];
  dte_min: number; dte_max: number;
  delta_novo_min: number; delta_novo_max: number;
  iv_rank_min: number; spread_max_pct: number; volume_min: number;
  hist_days: number; mc_paths: number;
  incluir_semanais: boolean;
  incluir_troca_ticker: boolean;
}

interface OpcaoMercado {
  symbol: string; strike: number;
  delta: number; theta: number | null; gamma: number | null;
  bid: number; ask: number; close: number | null; volume: number | null;
  dte: number; due_date: string;
}

interface PernaEstado extends PernaInput {
  mercado: OpcaoMercado | null;
  pl_por_acao: number | null; pl_total: number | null; alerta?: string;
}

// ── Parsing (CLOSE-first) ─────────────────────────────────────────────────────

function parseCloses(raw: unknown): number[] {
  const obj = raw as Record<string, unknown>;
  const arr = Array.isArray(raw) ? raw : Array.isArray(obj?.data) ? (obj.data as unknown[]) : [];
  const out: number[] = [];
  for (const c of arr) { const v = Number((c as Record<string, unknown>).close); if (isFinite(v) && v > 0) out.push(v); }
  return out;
}

function extractPutsSerie(raw: unknown): OpcaoMercado[] {
  const obj = raw as Record<string, unknown> | undefined;
  const series = obj && Array.isArray(obj.series) ? (obj.series as unknown[]) : Array.isArray(raw) ? raw : [];
  const puts: OpcaoMercado[] = [];
  for (const sRaw of series) {
    const s = sRaw as Record<string, unknown>;
    const dte = Number(s.days_to_maturity);
    const due = typeof s.due_date === "string" ? s.due_date.slice(0, 10) : "";
    const strikes = Array.isArray(s.strikes) ? (s.strikes as unknown[]) : [];
    for (const stRaw of strikes) {
      const st = stRaw as Record<string, unknown>;
      const p = st.put as Record<string, unknown> | undefined;
      if (!p || String(p.category ?? "").toUpperCase() !== "PUT") continue;
      const bs = (p.bs as Record<string, unknown>) ?? {};
      const delta = Number(bs.delta);
      const strike = Number(st.strike ?? p.strike);
      if (!isFinite(delta) || !isFinite(strike)) continue;
      const theta = Number(bs.theta), gamma = Number(bs.gamma), close = Number(p.close);
      puts.push({
        symbol: String(p.symbol ?? "").toUpperCase(), strike, delta,
        theta: isFinite(theta) ? theta : null,
        gamma: isFinite(gamma) ? gamma : null,
        bid: isFinite(Number(p.bid)) ? Number(p.bid) : 0,
        ask: isFinite(Number(p.ask)) ? Number(p.ask) : 0,
        close: isFinite(close) && close > 0 ? close : null,
        volume: null,
        dte: isFinite(dte) ? dte : Number(p.days_to_maturity),
        due_date: due || (typeof p.due_date === "string" ? p.due_date.slice(0, 10) : ""),
      });
    }
  }
  return puts;
}

function parseChain(raw: unknown): Map<string, { volume: number; close: number }> {
  const arr = Array.isArray(raw) ? raw : [];
  const m = new Map<string, { volume: number; close: number }>();
  for (const r of arr) {
    const o = r as Record<string, unknown>;
    const sym = String(o.symbol ?? "").toUpperCase();
    if (sym) m.set(sym, { volume: Number(o.volume ?? 0) || 0, close: Number(o.close ?? 0) || 0 });
  }
  return m;
}

// ── Vencimentos mensais (Ajuste 2) ────────────────────────────────────────────

/** Uma data é "mensal" na B3 se cai na 3ª sexta-feira do mês (dia 15–21, sexta). */
export function isVencimentoMensal(isoDate: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCDay() === 5 && +m[3] >= 15 && +m[3] <= 21;
}

// ── M4: estatística ───────────────────────────────────────────────────────────

export function volRealizadaAnualizada(closes: number[]): number {
  if (closes.length < 21) return NaN;
  const r: number[] = [];
  for (let i = 1; i < closes.length; i++) r.push(Math.log(closes[i] / closes[i - 1]));
  const mu = r.reduce((a, b) => a + b, 0) / r.length;
  const v = r.reduce((a, b) => a + (b - mu) ** 2, 0) / (r.length - 1);
  return Math.sqrt(v) * Math.sqrt(252);
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function gaussFactory(rand: () => number): () => number {
  let spare: number | null = null;
  return () => { if (spare !== null) { const v = spare; spare = null; return v; } let u = 0, v = 0; do { u = rand(); } while (u === 0); v = rand(); const mag = Math.sqrt(-2 * Math.log(u)); spare = mag * Math.sin(2 * Math.PI * v); return mag * Math.cos(2 * Math.PI * v); };
}
export interface MonteCarloResult { prob_terminal: number; prob_touch: number; }
export function monteCarloCruzarStrike(spot: number, strike: number, volAnual: number, dteCorridos: number, paths: number, seed = 42): MonteCarloResult {
  const steps = Math.max(1, Math.round(dteCorridos * (252 / 365)));
  const dt = 1 / 252, sigDt = volAnual * Math.sqrt(dt), drift = -0.5 * volAnual * volAnual * dt;
  const gauss = gaussFactory(mulberry32(seed));
  let terminal = 0, touch = 0;
  for (let p = 0; p < paths; p++) {
    let s = spot, tocou = false;
    for (let i = 0; i < steps; i++) { s *= Math.exp(drift + sigDt * gauss()); if (s < strike) tocou = true; }
    if (s < strike) terminal++;
    if (tocou) touch++;
  }
  return { prob_terminal: terminal / paths, prob_touch: touch / paths };
}
function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x)), d = 0.3989422804014327 * Math.exp(-x * x / 2);
  let p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  if (x > 0) p = 1 - p;
  return p;
}
export function probTerminalFechada(spot: number, strike: number, volAnual: number, dteCorridos: number): number {
  const T = Math.max(1, Math.round(dteCorridos * (252 / 365))) / 252;
  if (volAnual <= 0 || T <= 0) return spot < strike ? 1 : 0;
  return normCdf((Math.log(strike / spot) + 0.5 * volAnual * volAnual * T) / (volAnual * Math.sqrt(T)));
}

// ── Payoff exato de estrutura de N pernas (Ajuste 4) ─────────────────────────
// P&L(S) no vencimento p/ PUTs, respeitando quantidade e sinal de cada perna.
// Crédito de abertura: VENDA soma +entry, COMPRA soma −entry (× qty).
// No vencimento: VENDA paga −intrínseco, COMPRA recebe +intrínseco (× qty).
function plNoVencimento(legs: Array<{ side: string; strike: number; quantity: number; entry: number }>, S: number): number {
  let pl = 0;
  for (const l of legs) {
    const intr = Math.max(l.strike - S, 0);
    const sign = l.side === "VENDA" ? 1 : -1;
    pl += sign * l.entry * l.quantity;     // crédito/débito de abertura
    pl += -sign * intr * l.quantity;       // liquidação no vencimento
  }
  return pl;
}
/** Pior perda e melhor ganho avaliando o payoff nos pontos de quebra (strikes + 0). */
function extremosEstrutura(legs: Array<{ side: string; strike: number; quantity: number; entry: number }>): { piorPerda: number; melhorGanho: number } {
  const pts = [0, ...legs.map((l) => l.strike), Math.max(...legs.map((l) => l.strike)) * 2];
  let piorPerda = Infinity, melhorGanho = -Infinity;
  for (const S of pts) { const pl = plNoVencimento(legs, S); if (pl < piorPerda) piorPerda = pl; if (pl > melhorGanho) melhorGanho = pl; }
  return { piorPerda: round2(piorPerda), melhorGanho: round2(melhorGanho) };
}

// ── Normalização de parâmetros ────────────────────────────────────────────────

export function normalizarManejoParams(a: Record<string, unknown>): ManejoParams {
  const legsRaw = Array.isArray(a.legs) ? a.legs : [];
  const legs: PernaInput[] = legsRaw.map((l): PernaInput => {
    const o = l as Record<string, unknown>;
    return {
      option_ticker: String(o.option_ticker ?? "").toUpperCase(),
      side: String(o.side ?? "").toUpperCase() === "COMPRA" ? "COMPRA" as const : "VENDA" as const,
      quantity: Math.abs(Number(o.quantity)) || 0,
      entry_price: Number(o.entry_price) || 0,
    };
  }).filter((l) => l.option_ticker && l.quantity > 0);
  const num = (v: unknown, d: number) => (v !== undefined && v !== null && isFinite(Number(v)) ? Number(v) : d);
  const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : v === "true" ? true : v === "false" ? false : d);
  return {
    ticker: String(a.ticker ?? "").toUpperCase(),
    legs,
    dte_min: num(a.dte_min, 15),
    dte_max: num(a.dte_max, 95),
    delta_novo_min: num(a.delta_novo_min, -0.35),
    delta_novo_max: num(a.delta_novo_max, -0.15),
    iv_rank_min: num(a.iv_rank_min, 50),
    spread_max_pct: num(a.spread_max_pct, 15),
    volume_min: num(a.volume_min, 100),
    hist_days: num(a.hist_days, 90),
    mc_paths: Math.min(50_000, Math.max(2_000, num(a.mc_paths, 10_000))),
    incluir_semanais: bool(a.incluir_semanais, false),
    incluir_troca_ticker: bool(a.incluir_troca_ticker, true),
  };
}

function normalizarLegs(legsRaw: unknown): PernaInput[] {
  return (Array.isArray(legsRaw) ? legsRaw : []).map((l): PernaInput => {
    const o = l as Record<string, unknown>;
    return {
      option_ticker: String(o.option_ticker ?? "").toUpperCase(),
      side: String(o.side ?? "").toUpperCase() === "COMPRA" ? "COMPRA" as const : "VENDA" as const,
      quantity: Math.abs(Number(o.quantity)) || 0, entry_price: Number(o.entry_price) || 0,
    };
  }).filter((l) => l.option_ticker && l.quantity > 0);
}

// ── Ajuste 11: custo de desmontagem de UMA posição (para agregação) ───────────
async function desmontarPosicao(client: AxiosInstance, ticker: string, legs: PernaInput[]): Promise<Record<string, unknown>> {
  const tk = ticker.toUpperCase();
  const [serieRes, chainRes] = await Promise.allSettled([
    client.get(`/market/instruments/series/${tk}`, { params: { bs: true, irate: 15 }, timeout: REQUEST_TIMEOUT_MS }),
    client.get(`/market/options/${tk}`, { timeout: REQUEST_TIMEOUT_MS }),
  ]);
  if (serieRes.status !== "fulfilled") return { ticker: tk, erro: "série indisponível" };
  const puts = extractPutsSerie(serieRes.value.data);
  const chain = chainRes.status === "fulfilled" ? parseChain(chainRes.value.data) : new Map();
  for (const o of puts) { const c = chain.get(o.symbol); if (c && o.close === null && c.close > 0) o.close = c.close; }
  const bySym = new Map(puts.map((o) => [o.symbol, o]));
  const V = legs.filter((l) => l.side === "VENDA"), C = legs.filter((l) => l.side === "COMPRA");
  const closeOf = (l: PernaInput) => bySym.get(l.option_ticker)?.close ?? null;
  if (V.some((l) => closeOf(l) === null)) return { ticker: tk, erro: "sem close em perna vendida" };
  const doenteStrike = Math.max(...V.map((l) => bySym.get(l.option_ticker)?.strike ?? 0));
  const protPar = C.filter((l) => (bySym.get(l.option_ticker)?.strike ?? Infinity) < doenteStrike)
    .sort((a, b) => (bySym.get(b.option_ticker)!.strike) - (bySym.get(a.option_ticker)!.strike))[0] ?? null;
  const custoDesmontar = round2(V.reduce((s, l) => s + (closeOf(l) as number) * l.quantity, 0) - (protPar && closeOf(protPar) !== null ? (closeOf(protPar) as number) * protPar.quantity : 0));
  const custoCompleto = C.every((l) => closeOf(l) !== null)
    ? round2(V.reduce((s, l) => s + (closeOf(l) as number) * l.quantity, 0) - C.reduce((s, l) => s + (closeOf(l) as number) * l.quantity, 0)) : null;
  return { ticker: tk, custo_desmontar_pernas_problema: custoDesmontar, custo_estrutura_completa_liquido: custoCompleto };
}

// ── TROCA_TICKER (Ajuste 3) ───────────────────────────────────────────────────

async function avaliarTrocaTicker(
  client: AxiosInstance, p: ManejoParams, prejuizoRealizado: number, desembolsoDoente: number, excluir: string[] = [p.ticker]
): Promise<unknown> {
  const exSet = new Set(excluir.map((t) => t.toUpperCase()));
  const candidatosAtivos = WHITELIST_24.filter((t) => !exSet.has(t));
  // 1) IV Rank de toda a whitelist numa tacada (batched + cache)
  let ivRanking: Array<{ ticker: string; iv_rank: number }> = [];
  try {
    const bulk = (await getIVRankBulk(client, candidatosAtivos, 252)) as unknown as { ranking: Array<{ ticker: string; iv_rank: number }> };
    ivRanking = bulk.ranking.filter((r) => isFinite(r.iv_rank) && r.iv_rank > p.iv_rank_min);
  } catch (e) { return { disponivel: false, motivo: `IV Rank em lote indisponível: ${String(e)}` }; }
  ivRanking.sort((a, b) => b.iv_rank - a.iv_rank);
  const topIV = ivRanking.slice(0, 6);

  // 2) Tendência (M9/M21 ≥ 1) via get_stock, só para os top IV
  const comTendencia: Array<{ ticker: string; iv_rank: number; spot: number; m9m21: number }> = [];
  const stocks = await Promise.allSettled(topIV.map((r) => client.get(`/market/stocks/${r.ticker}`, { timeout: REQUEST_TIMEOUT_MS })));
  stocks.forEach((res, i) => {
    if (res.status !== "fulfilled") return;
    const o = res.value.data as Record<string, unknown>;
    const spot = Number(o.close ?? o.bid ?? o.spot_price);
    const m9m21 = Number((o.m9_m21 as Record<string, unknown> | undefined)?.value);
    if (isFinite(spot) && spot > 0 && isFinite(m9m21) && m9m21 >= 1.0) comTendencia.push({ ticker: topIV[i].ticker, iv_rank: topIV[i].iv_rank, spot, m9m21 });
  });
  if (comTendencia.length === 0) return { disponivel: true, candidatos: [], nota: "Nenhum ativo da whitelist com IV Rank>50 E tendência de alta agora." };

  // 3) Série dos 3 melhores → escolher short put delta -0,15/-0,30 com melhor prêmio (CLOSE)
  const alvos = comTendencia.slice(0, 3);
  const series = await Promise.allSettled(alvos.map((t) => client.get(`/market/instruments/series/${t.ticker}`, { params: { bs: true, irate: 15 }, timeout: REQUEST_TIMEOUT_MS })));
  const migracoes: Array<Record<string, unknown>> = [];
  series.forEach((res, i) => {
    if (res.status !== "fulfilled") return;
    const t = alvos[i];
    const allPuts = extractPutsSerie(res.value.data).filter((o) =>
      (p.incluir_semanais || isVencimentoMensal(o.due_date)) && o.dte >= p.dte_min && o.dte <= p.dte_max && o.close !== null);
    const candShort = allPuts.filter((o) => o.delta >= Math.max(p.delta_novo_min, -0.30) && o.delta <= p.delta_novo_max);
    if (candShort.length === 0) return;
    candShort.sort((a, b) => (b.close ?? 0) - (a.close ?? 0));
    const nova = candShort[0];
    // ── Ajuste 10: FECHA A TRAVA — proteção comprada mais OTM, formando trava de risco DEFINIDO ──
    // Percorre os strikes abaixo (do mais próximo ao mais OTM) e escolhe a 1ª proteção que
    // gera uma trava VÁLIDA: crédito < largura (risco máx positivo). Se crédito ≥ largura, o
    // "spread" é artefato de close ilíquido/defasado (lucro sem risco, impossível) e é pulado.
    const candProt = allPuts
      .filter((o) => o.strike < nova.strike && o.close !== null)
      .sort((a, b) => b.strike - a.strike);
    const prot = candProt.find((o) => (nova.close as number) - (o.close as number) < nova.strike - o.strike) ?? null;
    if (!prot) return; // sem trava viável de risco definido ⇒ não sugere venda seca (filosofia do operador)
    const qtyEquiv = Math.max(1, Math.round(desembolsoDoente / nova.strike)); // mesmo capital alocado
    const premioLiqAcao = round4((nova.close as number) - (prot.close as number));
    const largura = round2(nova.strike - prot.strike);
    const eficiencia = largura > 0 ? premioLiqAcao / largura : 0; // crédito ÷ largura (filtro ≥25%)
    const premioLiqTotal = round2(premioLiqAcao * qtyEquiv);
    const riscoMax = round2((largura - premioLiqAcao) * qtyEquiv);
    const probSucesso = 1 - Math.abs(nova.delta);
    const premioAjustado = premioLiqTotal * probSucesso; // prêmio LÍQUIDO esperado por ciclo
    const ciclosRecuperacao = premioAjustado > 0 ? round2(Math.abs(prejuizoRealizado) / premioAjustado) : null;
    const CICLOS_MAX = 3;
    const valeATroca = premioLiqAcao > 0 && eficiencia >= 0.25 && ciclosRecuperacao !== null && ciclosRecuperacao <= CICLOS_MAX && Math.abs(nova.delta) <= 0.30 && t.iv_rank > p.iv_rank_min && t.m9m21 >= 1.0;
    migracoes.push({
      ticker: t.ticker, iv_rank: round2(t.iv_rank), m9m21: round2(t.m9m21), spot: round2(t.spot),
      estrutura: "BULL_PUT_SPREAD", vencimento: nova.due_date, dte: nova.dte, qty_equivalente: qtyEquiv,
      vendida: { symbol: nova.symbol, strike: nova.strike, delta: round4(nova.delta), close: nova.close, liquidez_ref: { bid: nova.bid, ask: nova.ask, volume: nova.volume } },
      comprada_protecao: { symbol: prot.symbol, strike: prot.strike, delta: round4(prot.delta), close: prot.close, liquidez_ref: { bid: prot.bid, ask: prot.ask, volume: prot.volume } },
      premio_liquido_por_acao: premioLiqAcao, premio_liquido_total: premioLiqTotal, largura, eficiencia_pct: pct1(eficiencia), risco_maximo_total: riscoMax,
      premio_por_ciclo: premioLiqTotal, ciclos_para_recuperar: ciclosRecuperacao, prob_sucesso_aprox_pct: pct1(probSucesso), vale_a_troca: valeATroca,
    });
  });
  migracoes.sort((a, b) => Number(b.premio_liquido_total) - Number(a.premio_liquido_total));
  return { disponivel: true, prejuizo_a_recuperar: round2(Math.abs(prejuizoRealizado)), candidatos: migracoes };
}

// ── Motor principal ───────────────────────────────────────────────────────────

export async function getAnaliseManejo(client: AxiosInstance, args: Record<string, unknown>): Promise<unknown> {
  const p = normalizarManejoParams(args);
  const alertas: string[] = [];

  // ── Ajuste 11: DESMONTAGEM AGREGADA de múltiplas posições ────────────────────
  if (Array.isArray(args.posicoes) && args.posicoes.length > 0) {
    const posicoes = (args.posicoes as unknown[]).map((x) => {
      const o = x as Record<string, unknown>;
      return { ticker: String(o.ticker ?? "").toUpperCase(), legs: normalizarLegs(o.legs) };
    }).filter((x) => x.ticker && x.legs.length);
    if (posicoes.length === 0) throw new Error("posicoes: cada item precisa de {ticker, legs:[...]}");
    const custos = await Promise.all(posicoes.map((x) => desmontarPosicao(client, x.ticker, x.legs)));
    const somaDesmontar = round2(custos.reduce((s, c) => s + (typeof c.custo_desmontar_pernas_problema === "number" ? c.custo_desmontar_pernas_problema : 0), 0));
    const somaCompleto = round2(custos.reduce((s, c) => s + (typeof c.custo_estrutura_completa_liquido === "number" ? c.custo_estrutura_completa_liquido : 0), 0));
    const excluir = posicoes.map((x) => x.ticker);
    const desembolsoRef = Math.max(...custos.map((c) => Math.abs(typeof c.custo_desmontar_pernas_problema === "number" ? c.custo_desmontar_pernas_problema : 0)), somaDesmontar);
    const paramsAgg = { ...p, ticker: excluir[0] };
    const recuperacao = await avaliarTrocaTicker(client, paramsAgg, somaDesmontar, desembolsoRef, excluir);
    return {
      modo: "DESMONTAGEM_AGREGADA",
      base_calculo: "Cálculo pelo CLOSE. bid/ask/volume só liquidez. Motor não avalia patrimônio.",
      posicoes: custos,
      agregado: { custo_desmontar_pernas_problema_total: somaDesmontar, custo_estrutura_completa_liquido_total: somaCompleto },
      candidatos_recuperacao: recuperacao,
      nota: "Candidatos são travas (Bull Put Spread) que recuperam o custo agregado de desmontagem em ≤3 ciclos, com IV Rank>50, M9/M21≥1, delta -0,15/-0,30 e eficiência ≥25%.",
      disclaimer: "Valores pelo CLOSE (não é execução). Não é recomendação de investimento.",
    };
  }

  if (!p.ticker) throw new Error("Parâmetro obrigatório: ticker (ex: VALE3)");
  if (p.legs.length === 0) throw new Error("Parâmetro obrigatório: legs — [{option_ticker, side, quantity, entry_price}]");

  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const to = new Date();
  const fromH = new Date(to.getTime() - Math.ceil(p.hist_days * 1.6) * 86_400_000);

  const [stockRes, serieRes, chainRes, histRes] = await Promise.allSettled([
    client.get(`/market/stocks/${p.ticker}`, { timeout: REQUEST_TIMEOUT_MS }),
    (async () => {
      let irate = 15;
      try {
        const { data } = await client.get("/market/interest_rates", { timeout: REQUEST_TIMEOUT_MS });
        const arr = Array.isArray(data) ? data : [];
        const selic = arr.find((r) => /selic/i.test(String((r as Record<string, unknown>).name ?? (r as Record<string, unknown>).id ?? "")));
        const v = Number((selic as Record<string, unknown> | undefined)?.value);
        if (isFinite(v) && v > 0) irate = v;
      } catch { /* default */ }
      return client.get(`/market/instruments/series/${p.ticker}`, { params: { bs: true, irate }, timeout: REQUEST_TIMEOUT_MS });
    })(),
    client.get(`/market/options/${p.ticker}`, { timeout: REQUEST_TIMEOUT_MS }),
    client.get(`/market/historical/${p.ticker}/1d`, { params: { from: fmt(fromH), to: fmt(to) }, timeout: REQUEST_TIMEOUT_MS }),
  ]);

  if (serieRes.status === "rejected") throw new Error(`Falha ao buscar série de opções de ${p.ticker}: ${serieRes.reason}`);
  if (stockRes.status === "rejected") throw new Error(`Falha ao buscar dados do ativo ${p.ticker}: ${stockRes.reason}`);

  const stock = stockRes.value.data as Record<string, unknown>;
  const spot = Number(stock.close ?? stock.bid ?? stock.spot_price);
  const m9m21 = Number((stock.m9_m21 as Record<string, unknown> | undefined)?.value);
  const ivImplicita = Number(stock.iv_current);
  if (!isFinite(spot) || spot <= 0) throw new Error(`Spot inválido para ${p.ticker}`);

  const puts = extractPutsSerie(serieRes.value.data);
  if (puts.length === 0) throw new Error(`Nenhuma PUT na série de ${p.ticker}`);
  const chain = chainRes.status === "fulfilled" ? parseChain(chainRes.value.data) : new Map<string, { volume: number; close: number }>();
  for (const o of puts) { const c = chain.get(o.symbol); if (c) { o.volume = c.volume; if (o.close === null && c.close > 0) o.close = c.close; } }

  const closes = histRes.status === "fulfilled" ? parseCloses(histRes.value.data) : [];
  const volReal = volRealizadaAnualizada(closes.slice(-Math.max(22, p.hist_days)));
  const temVolReal = isFinite(volReal) && volReal > 0;
  if (!temVolReal) alertas.push("Histórico insuficiente — Monte Carlo indisponível; risco via delta (risco-neutro).");

  let ivRank: number | null = null;
  try { const r = (await getIVRankHistorico(client, p.ticker, 252)) as unknown as Record<string, unknown>; const v = Number(r.iv_rank); if (isFinite(v)) ivRank = v; }
  catch { alertas.push("IV Rank indisponível — filtro degradado para alerta."); }

  // ── M1: estado atual (CLOSE, N pernas ponderadas) ──────────────────────────
  const porSymbol = new Map(puts.map((o) => [o.symbol, o]));
  const pernas: PernaEstado[] = p.legs.map((l) => {
    const mkt = porSymbol.get(l.option_ticker) ?? null;
    const last = mkt ? mkt.close : null; // CLOSE only
    let plAcao: number | null = null;
    if (last !== null) plAcao = l.side === "VENDA" ? l.entry_price - last : last - l.entry_price;
    return { ...l, mercado: mkt, pl_por_acao: plAcao !== null ? round4(plAcao) : null, pl_total: plAcao !== null ? round2(plAcao * l.quantity) : null,
      alerta: mkt ? (mkt.close === null ? "INDISPONÍVEL — sem close para esta opção" : undefined) : "Opção não encontrada na série (vencida/ticker?)" };
  });

  const vendidas = pernas.filter((l) => l.side === "VENDA" && l.mercado);
  const compradas = pernas.filter((l) => l.side === "COMPRA" && l.mercado);
  if (vendidas.length === 0) throw new Error("Nenhuma perna VENDIDA localizada — manejo exige short put viva.");
  const doente = vendidas.reduce((a, b) => (Math.abs(a.mercado!.delta) >= Math.abs(b.mercado!.delta) ? a : b));
  const protecaoPar = compradas.filter((c) => c.mercado!.strike < doente.mercado!.strike).sort((a, b) => b.mercado!.strike - a.mercado!.strike)[0] ?? null;
  const qty = doente.quantity;

  const deltaLiquido = round2(pernas.reduce((s, l) => s + (l.mercado ? (l.side === "VENDA" ? -1 : 1) * l.mercado.delta * l.quantity : 0), 0));
  const gammaLiquido = pernas.every((l) => !l.mercado || l.mercado.gamma !== null)
    ? round4(pernas.reduce((s, l) => s + (l.mercado?.gamma ? (l.side === "VENDA" ? -1 : 1) * (l.mercado.gamma as number) * l.quantity : 0), 0)) : null;

  // P&L total (close) e extremos exatos da estrutura atual (Ajuste 4)
  const plEstruturaTotal = round2(pernas.reduce((s, l) => s + (l.pl_total ?? 0), 0));
  const legsPayoff = pernas.filter((l) => l.mercado).map((l) => ({ side: l.side, strike: l.mercado!.strike, quantity: l.quantity, entry: l.entry_price }));
  const { piorPerda, melhorGanho } = extremosEstrutura(legsPayoff);
  // ── Ajuste 8: DOIS custos de desmontagem (CLOSE), rotulados + detalhe por perna ──
  const cx = (l: PernaEstado) => l.mercado!.close as number;
  const fluxo = (l: PernaEstado) => round2((l.side === "VENDA" ? -1 : 1) * cx(l) * l.quantity); // caixa: recompra vendida=−, vende comprada=+
  // (a) Zerar a ESTRUTURA COMPLETA (líquido): recompra TODAS vendidas − vende TODAS compradas (credita long puts ITM valiosas).
  const semCloseCompleto = [...vendidas, ...compradas].some((l) => l.mercado!.close === null);
  const custoEstruturaCompleta = semCloseCompleto ? null : round2(
    vendidas.reduce((s, l) => s + cx(l) * l.quantity, 0) - compradas.reduce((s, l) => s + cx(l) * l.quantity, 0));
  const detalheCompleto = [...vendidas, ...compradas].filter((l) => l.mercado!.close !== null).map((l) => ({
    option_ticker: l.option_ticker, acao: l.side === "VENDA" ? "RECOMPRAR" : "VENDER", close: cx(l), quantity: l.quantity, fluxo_caixa: fluxo(l) }));
  // (b) Desmontar só as PERNAS-PROBLEMA: recompra as vendidas + vende SÓ a proteção pareada (não credita as long puts ITM valiosas).
  const semCloseDesmontar = vendidas.some((l) => l.mercado!.close === null) || (!!protecaoPar && protecaoPar.mercado!.close === null);
  const custoDesmontarPernas = semCloseDesmontar ? null : round2(
    vendidas.reduce((s, l) => s + cx(l) * l.quantity, 0) - (protecaoPar ? cx(protecaoPar) * protecaoPar.quantity : 0));
  const detalheDesmontar = [...vendidas, ...(protecaoPar ? [protecaoPar] : [])].filter((l) => l.mercado!.close !== null).map((l) => ({
    option_ticker: l.option_ticker, acao: l.side === "VENDA" ? "RECOMPRAR" : "VENDER (proteção pareada)", close: cx(l), quantity: l.quantity, fluxo_caixa: fluxo(l) }));
  void custoEstruturaCompleta;
  // Âncora de decisão (Ajuste 9): custo presente de desmontar as pernas-problema.
  const custoAncora = custoDesmontarPernas ?? custoEstruturaCompleta;

  const mcAtual = temVolReal ? monteCarloCruzarStrike(spot, doente.mercado!.strike, volReal, doente.mercado!.dte, p.mc_paths, 42) : null;

  // ── Ajuste 7: alerta IV implícita vs realizada ─────────────────────────────
  let alertaVol: string | null = null;
  if (temVolReal && isFinite(ivImplicita)) {
    const diff = volReal * 100 - ivImplicita;
    if (diff > 3) alertaVol = `DELTA OTIMISTA — vol realizada ${round2(volReal * 100)}% > IV implícita ${round2(ivImplicita)}%: mercado precifica MENOS risco que o histórico; probabilidade real de exercício ACIMA do delta.`;
    else if (diff < -3) alertaVol = `PRÊMIO GORDO — IV implícita ${round2(ivImplicita)}% > vol realizada ${round2(volReal * 100)}%: favorável ao vendedor.`;
    if (alertaVol) alertas.push(alertaVol);
  }

  // ── M2: candidatos de rolagem (MENSAIS por padrão) ─────────────────────────
  const vencAlvo = [...new Set(puts
    .filter((o) => o.dte >= p.dte_min && o.dte <= p.dte_max && o.due_date > doente.mercado!.due_date && (p.incluir_semanais || isVencimentoMensal(o.due_date)))
    .map((o) => o.due_date))].sort().slice(0, 3);
  if (vencAlvo.length === 0) alertas.push(`Nenhum vencimento ${p.incluir_semanais ? "" : "MENSAL "}na janela ${p.dte_min}-${p.dte_max} DTE após ${doente.mercado!.due_date}. Ajuste dte_min/dte_max ou use incluir_semanais=true.`);
  const larguraAtual = protecaoPar ? round2(doente.mercado!.strike - protecaoPar.mercado!.strike) : null;

  interface Bruto { tipo: string; venda: OpcaoMercado; compra: OpcaoMercado | null; mantemProt: boolean; desc: string }
  const brutos: Bruto[] = [];
  for (const due of vencAlvo) {
    const doVenc = puts.filter((o) => o.due_date === due && o.close !== null);
    const mesmoStrike = doVenc.filter((o) => Math.abs(o.strike - doente.mercado!.strike) / doente.mercado!.strike <= 0.02).sort((a, b) => Math.abs(a.strike - doente.mercado!.strike) - Math.abs(b.strike - doente.mercado!.strike))[0];
    const defensivas = doVenc.filter((o) => o.delta >= p.delta_novo_min && o.delta <= p.delta_novo_max).sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta)).slice(0, 2);
    for (const venda of [mesmoStrike, ...defensivas].filter(Boolean) as OpcaoMercado[]) {
      const tipoBase = venda === mesmoStrike ? "CALENDARIO" : "DEFENSIVA";
      if (protecaoPar) {
        if (protecaoPar.mercado!.due_date >= due && protecaoPar.mercado!.strike < venda.strike)
          brutos.push({ tipo: tipoBase, venda, compra: null, mantemProt: true, desc: `Rolar só a vendida p/ ${venda.symbol} (${due}); manter proteção ${protecaoPar.option_ticker}` });
        const alvo = venda.strike - (larguraAtual ?? 0);
        const novaProt = doVenc.filter((o) => o.strike < venda.strike).sort((a, b) => Math.abs(a.strike - alvo) - Math.abs(b.strike - alvo))[0];
        if (novaProt) brutos.push({ tipo: tipoBase, venda, compra: novaProt, mantemProt: false, desc: `Rolar trava inteira p/ ${venda.symbol}/${novaProt.symbol} (${due})` });
        const maisLargo = doVenc.filter((o) => o.strike < alvo).sort((a, b) => b.strike - a.strike)[0];
        if (maisLargo && novaProt && maisLargo.symbol !== novaProt.symbol) brutos.push({ tipo: "LARGURA", venda, compra: maisLargo, mantemProt: false, desc: `Rolar alargando a trava p/ ${venda.symbol}/${maisLargo.symbol} (${due})` });
      } else {
        brutos.push({ tipo: tipoBase, venda, compra: null, mantemProt: false, desc: `Rolar short put a seco p/ ${venda.symbol} (${due})` });
      }
    }
  }
  const vistos = new Set<string>();
  const unicos = brutos.filter((b) => { const k = `${b.venda.symbol}|${b.compra?.symbol ?? (b.mantemProt ? "KEEP" : "NAKED")}`; if (vistos.has(k)) return false; vistos.add(k); return true; }).slice(0, 12);

  // ── M3+M4+M5: precificar (CLOSE), stats, filtrar ──────────────────────────
  const closeRecompra = doente.mercado!.close; // CLOSE only
  const deltaAtualAbs = Math.abs(doente.mercado!.delta);
  const mcCache = new Map<string, MonteCarloResult>();
  const maxDesembolsoCand = Math.max(...unicos.map((b) => b.venda.strike * qty), 1);

  const candidatos = unicos.map((b, i) => {
    const closeNova = b.venda.close as number;
    const closeProtAntiga = protecaoPar?.mercado!.close ?? null;
    const closeProtNova = b.compra ? b.compra.close : null;
    // crédito líquido por ação (base CLOSE); proteção antiga ponderada pela qty dela
    let cred: number | null = null;
    const faltaPreco = closeRecompra === null || closeNova === null || (b.compra && closeProtNova === null) || (protecaoPar && !b.mantemProt && closeProtAntiga === null);
    if (!faltaPreco) {
      cred = closeNova - (closeRecompra as number);
      if (protecaoPar && !b.mantemProt) cred += (closeProtAntiga as number) * (protecaoPar.quantity / qty);
      if (b.compra) cred -= (closeProtNova as number);
    }
    const credTotal = cred !== null ? round2(cred * qty) : null;
    const largura = b.compra ? b.venda.strike - b.compra.strike : (b.mantemProt && protecaoPar ? b.venda.strike - protecaoPar.mercado!.strike : null);
    const riscoMax = largura !== null && cred !== null ? round2((largura - cred) * qty) : null;
    const beNovo = cred !== null ? round2(b.venda.strike - Math.max(0, cred)) : null;
    const desembolso = round2(b.venda.strike * qty); // Ajuste 6

    let mc: MonteCarloResult | null = null;
    if (temVolReal) { const k = `${b.venda.strike}|${b.venda.dte}`; if (!mcCache.has(k)) mcCache.set(k, monteCarloCruzarStrike(spot, b.venda.strike, volReal, b.venda.dte, p.mc_paths, 42)); mc = mcCache.get(k)!; }

    const cand = {
      id: `C${i + 1}`, tipo: b.tipo, descricao: b.desc, vencimento: b.venda.due_date, mensal: isVencimentoMensal(b.venda.due_date), dte: b.venda.dte,
      nova_vendida: { symbol: b.venda.symbol, strike: b.venda.strike, delta: round4(b.venda.delta), close: closeNova, liquidez_ref: { bid: b.venda.bid, ask: b.venda.ask, volume: b.venda.volume } },
      nova_comprada: b.compra ? { symbol: b.compra.symbol, strike: b.compra.strike, delta: round4(b.compra.delta), close: b.compra.close, liquidez_ref: { bid: b.compra.bid, ask: b.compra.ask, volume: b.compra.volume } } : null,
      mantem_protecao_atual: b.mantemProt,
      credito_liquido_por_acao: cred !== null ? round4(cred) : "INDISPONÍVEL",
      credito_liquido_total: credTotal ?? "INDISPONÍVEL",
      delta_pos_rolagem: round4(b.venda.delta),
      theta_dia_por_acao: b.venda.theta !== null ? round4(Math.abs(b.venda.theta)) : (closeNova ? round4(closeNova / Math.max(1, b.venda.dte)) : null),
      gamma_por_acao: b.venda.gamma !== null ? round4(b.venda.gamma) : null,
      breakeven_novo: beNovo ?? "INDISPONÍVEL",
      distancia_be_spot_pct: beNovo !== null ? pct1((spot - beNovo) / spot) : null,
      risco_maximo_total: riscoMax, notional_risco: round2(b.venda.strike * qty),
      desembolso_maximo_se_exercido: desembolso,
      prob_mc_exercicio_pct: mc ? pct1(mc.prob_terminal) : null,
      prob_mc_touch_pct: mc ? pct1(mc.prob_touch) : null,
      prob_formula_fechada_pct: temVolReal ? pct1(probTerminalFechada(spot, b.venda.strike, volReal, b.venda.dte)) : null,
      status: "APROVADO" as string, motivo_eliminacao: null as string | null, score: null as number | null, alerta_cauda: null as string | null,
    };

    // Ajuste 6: alerta de risco de cauda (delta baixo + desembolso desproporcional)
    if (Math.abs(b.venda.delta) < 0.20 && desembolso >= 0.9 * maxDesembolsoCand && unicos.length > 1)
      cand.alerta_cauda = `risco de cauda — delta baixo (${round4(b.venda.delta)}) com desembolso máximo alto (R$ ${desembolso}).`;

    // ── M5: filtros hard (base CLOSE) ────────────────────────────────────────
    const spreadPct = b.venda.bid > 0 && b.venda.ask > 0 ? ((b.venda.ask - b.venda.bid) / ((b.venda.ask + b.venda.bid) / 2)) * 100 : null;
    const elimina = (m: string) => { cand.status = "ELIMINADO"; cand.motivo_eliminacao = m; };
    if (faltaPreco || cred === null) elimina("dados_incompletos — sem CLOSE em alguma perna (verificar na corretora)");
    else if (cred <= 0) elimina(`crédito_negativo (${round4(cred)}/ação) — rolagem a débito é proibida`);
    else if (Math.abs(b.venda.delta) >= deltaAtualAbs) elimina(`delta_não_reduz (novo ${round4(Math.abs(b.venda.delta))} ≥ atual ${round4(deltaAtualAbs)})`);
    else if (Math.abs(b.venda.delta) > 0.70) elimina("delta_acima_de_0.70 — proibido p/ short put");
    else if (isFinite(m9m21) && m9m21 < 1.0) elimina(`tendência_contra (M9/M21=${round2(m9m21)} < 1,00)`);
    else if (spreadPct !== null && spreadPct > p.spread_max_pct) elimina(`spread_alto (${round2(spreadPct)}% > ${p.spread_max_pct}%) [liquidez]`);
    else if (b.venda.volume !== null && b.venda.volume < p.volume_min) elimina(`volume_baixo (${b.venda.volume} < ${p.volume_min}) [liquidez]`);
    else if (ivRank !== null && ivRank < p.iv_rank_min) elimina(`iv_rank_baixo (${round2(ivRank)} < ${p.iv_rank_min})`);
    return cand;
  });

  // ── M6: score e decisão ─────────────────────────────────────────────────────
  const aprovados = candidatos.filter((c) => c.status === "APROVADO");
  for (const c of aprovados) {
    const credTot = typeof c.credito_liquido_total === "number" ? c.credito_liquido_total : 0;
    const roic = c.risco_maximo_total !== null ? credTot / Math.max(c.risco_maximo_total, 0.01 * c.notional_risco) : credTot / c.notional_risco;
    const pSobrevive = c.prob_mc_exercicio_pct !== null ? 1 - c.prob_mc_exercicio_pct / 100 : 1 - Math.abs(c.delta_pos_rolagem);
    c.score = round4(roic * (c.theta_dia_por_acao ?? 0.001) * qty * pSobrevive);
  }
  aprovados.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const vencedor = aprovados[0] ?? null;

  // ── Ajuste 3: gatilho de troca de ticker ────────────────────────────────────
  const falhas = [deltaAtualAbs > 0.50, isFinite(m9m21) && m9m21 < 1.0, ivRank !== null && ivRank < 50].filter(Boolean).length;
  let trocaTicker: unknown = { avaliado: false, motivo: falhas < 2 ? `ativo saudável (${falhas}/3 critérios ruins) — troca não acionada` : "desativado por parâmetro" };
  if (p.incluir_troca_ticker && falhas >= 2) {
    const prejuizo = custoAncora !== null ? custoAncora : 0; // Ajuste 9: âncora = custo presente de desmontar (não o P&L de montagem)
    trocaTicker = { avaliado: true, gatilho: `${falhas}/3 critérios ruins (delta>${0.50}? ${deltaAtualAbs > 0.5} | M9M21<1? ${isFinite(m9m21) && m9m21 < 1} | IVRank<50? ${ivRank !== null && ivRank < 50})`, ...(await avaliarTrocaTicker(client, p, prejuizo, doente.mercado!.strike * qty) as object) };
  }

  const decisao = vencedor
    ? { acao: "ROLAR", candidato: vencedor.id, racional: `Melhor score entre ${aprovados.length}/${candidatos.length}: crédito R$ ${vencedor.credito_liquido_total}, delta ${vencedor.delta_pos_rolagem} (vs ${round4(-deltaAtualAbs)}), venc ${vencedor.mensal ? "MENSAL" : "semanal"} ${vencedor.vencimento}, P(exerc real) ${vencedor.prob_mc_exercicio_pct ?? "n/d"}%.`,
        plano_execucao: [
          `1. COMPRAR (fechar) ${qty} ${doente.option_ticker} — ref. CLOSE R$ ${closeRecompra}`,
          ...(protecaoPar && !vencedor.mantem_protecao_atual ? [`2. VENDER (fechar) ${protecaoPar.quantity} ${protecaoPar.option_ticker} — ref. CLOSE R$ ${protecaoPar.mercado!.close}`] : []),
          `${protecaoPar && !vencedor.mantem_protecao_atual ? 3 : 2}. VENDER (abrir) ${qty} ${vencedor.nova_vendida.symbol} — ref. CLOSE R$ ${vencedor.nova_vendida.close}`,
          ...(vencedor.nova_comprada ? [`${protecaoPar && !vencedor.mantem_protecao_atual ? 4 : 3}. COMPRAR (abrir) ${qty} ${vencedor.nova_comprada.symbol} — ref. CLOSE R$ ${vencedor.nova_comprada.close}`] : []),
          `Crédito líquido esperado ~R$ ${vencedor.credito_liquido_total} | novo BE R$ ${vencedor.breakeven_novo}. Validar no book vivo do próximo pregão.`,
        ] }
    : { acao: "NAO_ROLAR — avaliar ASSUMIR / ENCERRAR / TROCA DE TICKER", candidato: null,
        racional: `Nenhuma rolagem a crédito sobreviveu (${candidatos.length} avaliados). Âncora da decisão = custo PRESENTE de desmontar as pernas-problema R$ ${custoDesmontarPernas ?? "INDISPONÍVEL"} (não o P&L de montagem). ${(trocaTicker as { avaliado?: boolean }).avaliado ? "Veja troca_ticker abaixo." : ""}`,
        plano_execucao: [
          custoEstruturaCompleta !== null ? `ENCERRAR estrutura completa (líquido): ~R$ ${custoEstruturaCompleta} (credita as long puts ITM).` : "ENCERRAR completo: INDISPONÍVEL.",
          custoDesmontarPernas !== null ? `DESMONTAR só as pernas-problema (âncora): ~R$ ${custoDesmontarPernas} (recompra vendidas + vende só a proteção pareada).` : "DESMONTAR pernas-problema: INDISPONÍVEL.",
          `ASSUMIR: exercício da ${doente.option_ticker} = comprar ${qty} ${p.ticker} a R$ ${doente.mercado!.strike} (R$ ${round2(doente.mercado!.strike * qty)}); pior perda da estrutura R$ ${piorPerda}.`,
          "Reavaliar no próximo pregão: novo book/série pode reabrir candidato a crédito.",
        ] };

  return {
    ticker: p.ticker,
    base_calculo: "Cálculo baseado no CLOSE. Execução a validar no book vivo do próximo pregão. bid/ask/volume são referência de liquidez apenas.",
    parametros: p,
    mercado: {
      spot: round2(spot), m9_m21: isFinite(m9m21) ? round2(m9m21) : null, tendencia: isFinite(m9m21) ? (m9m21 >= 1 ? "ALTA" : "BAIXA") : "n/d",
      iv_implicita_atual: isFinite(ivImplicita) ? round2(ivImplicita) : null, vol_realizada_anualizada: temVolReal ? round2(volReal * 100) : null,
      alerta_vol: alertaVol, iv_rank_252d: ivRank, candles_historico: closes.length, mc_paths: p.mc_paths,
    },
    estado_atual: {
      estrutura: protecaoPar ? "BULL_PUT_SPREAD" : (compradas.length ? "MULTI_PERNA" : "SHORT_PUT_SECO"),
      pernas: pernas.map((l) => ({ option_ticker: l.option_ticker, side: l.side, quantity: l.quantity, entry_price: l.entry_price,
        strike: l.mercado?.strike ?? null, delta: l.mercado?.delta ?? null, theta: l.mercado?.theta ?? null, gamma: l.mercado?.gamma ?? null,
        close: l.mercado?.close ?? "INDISPONÍVEL", liquidez_ref: l.mercado ? { bid: l.mercado.bid, ask: l.mercado.ask, volume: l.mercado.volume } : null,
        dte: l.mercado?.dte ?? null, vencimento: l.mercado?.due_date ?? null, mensal: l.mercado ? isVencimentoMensal(l.mercado.due_date) : null,
        moneyness: l.mercado ? (spot < l.mercado.strike ? "ITM" : spot * 0.98 <= l.mercado.strike ? "ATM" : "OTM") : null, pl_total: l.pl_total, alerta: l.alerta })),
      perna_dirigindo_risco: doente.option_ticker,
      delta_liquido_ponderado: deltaLiquido, gamma_liquido_ponderado: gammaLiquido,
      largura_trava: larguraAtual,
      pl_estrutura_total_close: plEstruturaTotal,
      pior_perda_no_vencimento: piorPerda, melhor_ganho_no_vencimento: melhorGanho,
      custo_zerar_estrutura_completa_liquido: { total: custoEstruturaCompleta ?? "INDISPONÍVEL", detalhe: detalheCompleto },
      custo_desmontar_pernas_problema: { total: custoDesmontarPernas ?? "INDISPONÍVEL", detalhe: detalheDesmontar, obs: "Âncora de decisão (Ajuste 9): custo presente que compete com rolar/trocar." },
      desembolso_maximo_se_exercido: round2(vendidas.reduce((s, l) => s + l.mercado!.strike * l.quantity, 0) - compradas.reduce((s, l) => s + l.mercado!.strike * l.quantity, 0)),
      divergencia_delta_vs_real: mcAtual ? { delta_bs_pct: pct1(deltaAtualAbs), prob_real_mc_pct: pct1(mcAtual.prob_terminal), prob_touch_mc_pct: pct1(mcAtual.prob_touch),
        leitura: Math.abs(mcAtual.prob_terminal - deltaAtualAbs) > 0.05 ? "Delta diverge do risco real — confiar no Monte Carlo" : "Delta consistente com o histórico" } : null,
    },
    candidatos_rolagem: candidatos,
    ranking_aprovados: aprovados.map((c) => ({ id: c.id, descricao: c.descricao, mensal: c.mensal, score: c.score, credito_total: c.credito_liquido_total, delta: c.delta_pos_rolagem, prob_exercicio_pct: c.prob_mc_exercicio_pct })),
    troca_ticker: trocaTicker,
    decisao,
    alertas,
    disclaimer: "Valores pelo CLOSE (não é execução). O motor não avalia patrimônio/colchão/concentração — isso é decisão do operador. Não é recomendação de investimento.",
  };
}
