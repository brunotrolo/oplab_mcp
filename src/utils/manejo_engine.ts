// ─────────────────────────────────────────────────────────────────────────────
// manejo_engine.ts — Motor de Manejo/Rolagem de posições ATM/ITM
//
// Escopo: Short Put a seco e Bull Put Spread (únicas estratégias autorizadas).
// Implementa a arquitetura de 6 módulos:
//   M1 Estado atual    → gregas por perna, delta líquido, P&L, BE, custo de zerar
//   M2 Candidatos      → calendário (mesmo strike), defensiva (strike novo),
//                        largura nova da trava, e "manter proteção" quando válida
//   M3 Precificação    → crédito EXECUTÁVEL (recompra a ASK, venda a BID),
//                        delta pós-rolagem, theta, breakeven, risco máximo
//   M4 Estatística     → vol REALIZADA (log-returns) + Monte Carlo (GBM, seed
//                        determinística) + fórmula fechada de cross-check +
//                        divergência delta (B-S risco-neutro) vs prob. real
//   M5 Filtros hard    → crédito<=0, delta não reduz, |delta|>0.70, tendência
//                        M9/M21 contra, liquidez (bid/spread/volume), IV Rank
//   M6 Score & decisão → Score = ROIC × theta/dia × (1 − prob_MC); se nenhum
//                        sobrevive → ASSUMIR/ENCERRAR quantificados
//
// Regras de ouro respeitadas: nunca inventa dados (campos ausentes ⇒ candidato
// eliminado com motivo "dados_incompletos" ou alerta explícito); delta é a
// métrica primária; toda alternativa descartada sai no output com o motivo.
// ─────────────────────────────────────────────────────────────────────────────

import { AxiosInstance } from "axios";
import { getIVRankHistorico } from "./iv_calculator.js";

const REQUEST_TIMEOUT_MS = 25_000;
const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
const pct1 = (n: number) => Math.round(n * 1000) / 10; // fração → % com 1 casa

// ── Tipos ─────────────────────────────────────────────────────────────────────

export interface PernaInput {
  option_ticker: string;
  side: "VENDA" | "COMPRA";
  quantity: number;
  entry_price: number;
}

export interface ManejoParams {
  ticker: string;
  legs: PernaInput[];
  dte_min: number;          // janela alvo do novo vencimento
  dte_max: number;
  delta_novo_min: number;   // delta alvo da nova vendida (mais negativo aceito)
  delta_novo_max: number;   // (menos negativo aceito)
  iv_rank_min: number;      // IV Rank mínimo p/ vender vol (filtro M5)
  spread_max_pct: number;   // spread bid/ask máximo (% do mid)
  volume_min: number;       // volume mínimo (contratos) da nova opção
  hist_days: number;        // janela da vol realizada
  mc_paths: number;         // trajetórias Monte Carlo
}

interface OpcaoMercado {
  symbol: string;
  strike: number;
  delta: number;
  theta: number | null;
  bid: number;
  ask: number;
  close: number | null;
  volume: number | null;
  dte: number;
  due_date: string;
}

interface PernaEstado extends PernaInput {
  mercado: OpcaoMercado | null;
  pl_por_acao: number | null;
  pl_total: number | null;
  alerta?: string;
}

interface Candidato {
  id: string;
  tipo: "CALENDARIO" | "DEFENSIVA" | "LARGURA" | "SEM_PROTECAO";
  descricao: string;
  vencimento: string;
  dte: number;
  nova_vendida: { symbol: string; strike: number; delta: number; bid: number; ask: number; volume: number | null };
  nova_comprada: { symbol: string; strike: number; delta: number; bid: number; ask: number; volume: number | null } | null;
  mantem_protecao_atual: boolean;
  // M3
  credito_liquido_por_acao: number;
  credito_liquido_total: number;
  delta_pos_rolagem: number;
  theta_dia_por_acao: number | null;
  breakeven_novo: number;
  distancia_be_spot_pct: number;
  risco_maximo_total: number | null; // null = short put a seco (risco = notional)
  notional_risco: number;
  // M4
  prob_mc_exercicio_pct: number | null;   // P(S_T < strike_vendida) com vol real
  prob_mc_touch_pct: number | null;       // P(min S_t < strike) — tocou o strike
  prob_formula_fechada_pct: number | null;
  // M5/M6
  status: "APROVADO" | "ELIMINADO";
  motivo_eliminacao: string | null;
  score: number | null;
}

// ── Parsing defensivo das respostas da OpLab ─────────────────────────────────

function parseCloses(raw: unknown): number[] {
  const obj = raw as Record<string, unknown>;
  const arr = Array.isArray(raw) ? raw : Array.isArray(obj?.data) ? (obj.data as unknown[]) : [];
  const closes: number[] = [];
  for (const c of arr) {
    const close = Number((c as Record<string, unknown>).close);
    if (isFinite(close) && close > 0) closes.push(close);
  }
  return closes;
}

/** Extrai TODAS as puts da série bs=true (delta/theta em put.bs, bid/ask no topo). */
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
      const theta = Number(bs.theta);
      const strike = Number(st.strike ?? p.strike);
      if (!isFinite(delta) || !isFinite(strike)) continue;
      puts.push({
        symbol: String(p.symbol ?? "").toUpperCase(),
        strike,
        delta,
        theta: isFinite(theta) ? theta : null,
        bid: isFinite(Number(p.bid)) ? Number(p.bid) : 0,
        ask: isFinite(Number(p.ask)) ? Number(p.ask) : 0,
        close: isFinite(Number(p.close)) ? Number(p.close) : null,
        volume: null, // preenchido depois via cadeia /market/options
        dte: isFinite(dte) ? dte : Number(p.days_to_maturity),
        due_date: due || (typeof p.due_date === "string" ? p.due_date.slice(0, 10) : ""),
      });
    }
  }
  return puts;
}

/** Mapa symbol → {volume, close} vindo da cadeia /market/options/{tk}. */
function parseChain(raw: unknown): Map<string, { volume: number; close: number }> {
  const arr = Array.isArray(raw) ? raw : [];
  const m = new Map<string, { volume: number; close: number }>();
  for (const r of arr) {
    const o = r as Record<string, unknown>;
    const sym = String(o.symbol ?? "").toUpperCase();
    if (!sym) continue;
    m.set(sym, { volume: Number(o.volume ?? 0) || 0, close: Number(o.close ?? 0) || 0 });
  }
  return m;
}

// ── M4: estatística — vol realizada, Monte Carlo, fórmula fechada ────────────

export function volRealizadaAnualizada(closes: number[]): number {
  if (closes.length < 21) return NaN;
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const media = rets.reduce((a, b) => a + b, 0) / rets.length;
  const varr = rets.reduce((a, b) => a + (b - media) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(varr) * Math.sqrt(252);
}

/** PRNG determinístico (mulberry32) — resultados reproduzíveis entre chamadas. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Normal(0,1) via Box-Muller com PRNG semeado. */
function gaussFactory(rand: () => number): () => number {
  let spare: number | null = null;
  return () => {
    if (spare !== null) { const v = spare; spare = null; return v; }
    let u = 0, v = 0;
    do { u = rand(); } while (u === 0);
    v = rand();
    const mag = Math.sqrt(-2 * Math.log(u));
    spare = mag * Math.sin(2 * Math.PI * v);
    return mag * Math.cos(2 * Math.PI * v);
  };
}

export interface MonteCarloResult {
  prob_terminal: number; // P(S_T < K)
  prob_touch: number;    // P(min S_t < K)
}

/**
 * GBM com drift zero (conservador: sem apostar em direção) e vol REALIZADA.
 * dte em dias corridos → passos em dias úteis (≈252/365).
 */
export function monteCarloCruzarStrike(
  spot: number, strike: number, volAnual: number, dteCorridos: number, paths: number, seed = 42
): MonteCarloResult {
  const steps = Math.max(1, Math.round(dteCorridos * (252 / 365)));
  const dt = 1 / 252;
  const sigDt = volAnual * Math.sqrt(dt);
  const drift = -0.5 * volAnual * volAnual * dt;
  const gauss = gaussFactory(mulberry32(seed));
  let terminal = 0, touch = 0;
  for (let p = 0; p < paths; p++) {
    let s = spot;
    let tocou = false;
    for (let i = 0; i < steps; i++) {
      s *= Math.exp(drift + sigDt * gauss());
      if (s < strike) tocou = true;
    }
    if (s < strike) terminal++;
    if (tocou) touch++;
  }
  return { prob_terminal: terminal / paths, prob_touch: touch / paths };
}

/** Φ — CDF normal padrão (aproximação de Abramowitz-Stegun, erro < 7.5e-8). */
function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  let p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  if (x > 0) p = 1 - p;
  return p;
}

/** P(S_T < K) analítica sob GBM drift-zero — cross-check do Monte Carlo. */
export function probTerminalFechada(spot: number, strike: number, volAnual: number, dteCorridos: number): number {
  const T = Math.max(1, Math.round(dteCorridos * (252 / 365))) / 252;
  if (volAnual <= 0 || T <= 0) return spot < strike ? 1 : 0;
  const z = (Math.log(strike / spot) + 0.5 * volAnual * volAnual * T) / (volAnual * Math.sqrt(T));
  return normCdf(z);
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
  const num = (v: unknown, d: number) => (isFinite(Number(v)) && v !== undefined && v !== null ? Number(v) : d);
  return {
    ticker: String(a.ticker ?? "").toUpperCase(),
    legs,
    dte_min: num(a.dte_min, 20),
    dte_max: num(a.dte_max, 75),
    delta_novo_min: num(a.delta_novo_min, -0.35),
    delta_novo_max: num(a.delta_novo_max, -0.15),
    iv_rank_min: num(a.iv_rank_min, 50),
    spread_max_pct: num(a.spread_max_pct, 15),
    volume_min: num(a.volume_min, 100),
    hist_days: num(a.hist_days, 90),
    mc_paths: Math.min(50_000, Math.max(2_000, num(a.mc_paths, 10_000))),
  };
}

// ── Motor principal ───────────────────────────────────────────────────────────

export async function getAnaliseManejo(client: AxiosInstance, args: Record<string, unknown>): Promise<unknown> {
  const p = normalizarManejoParams(args);
  const alertas: string[] = [];
  if (!p.ticker) throw new Error("Parâmetro obrigatório: ticker (ex: VALE3)");
  if (p.legs.length === 0) throw new Error("Parâmetro obrigatório: legs — [{option_ticker, side: VENDA|COMPRA, quantity, entry_price}]");

  // ── Coleta paralela: stock, série bs, cadeia (volumes), histórico ──────────
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const to = new Date();
  const from = new Date(to.getTime() - Math.ceil(p.hist_days * 1.6) * 86_400_000);

  const [stockRes, taxaRes, serieRes, chainRes, histRes] = await Promise.allSettled([
    client.get(`/market/stocks/${p.ticker}`, { timeout: REQUEST_TIMEOUT_MS }),
    client.get("/market/interest_rates", { timeout: REQUEST_TIMEOUT_MS }),
    (async () => {
      // série precisa da taxa p/ B-S — busca em cascata (taxa → série)
      let irate = 15;
      try {
        const { data } = await client.get("/market/interest_rates", { timeout: REQUEST_TIMEOUT_MS });
        const arr = Array.isArray(data) ? data : [];
        const selic = arr.find((r) => /selic/i.test(String((r as Record<string, unknown>).name ?? (r as Record<string, unknown>).id ?? "")));
        const v = Number((selic as Record<string, unknown> | undefined)?.value);
        if (isFinite(v) && v > 0) irate = v;
      } catch { /* usa default */ }
      return client.get(`/market/instruments/series/${p.ticker}`, { params: { bs: true, irate }, timeout: REQUEST_TIMEOUT_MS });
    })(),
    client.get(`/market/options/${p.ticker}`, { timeout: REQUEST_TIMEOUT_MS }),
    client.get(`/market/historical/${p.ticker}/1d`, { params: { from: fmt(from), to: fmt(to) }, timeout: REQUEST_TIMEOUT_MS }),
  ]);

  if (serieRes.status === "rejected") throw new Error(`Falha ao buscar série de opções de ${p.ticker}: ${serieRes.reason}`);
  if (stockRes.status === "rejected") throw new Error(`Falha ao buscar dados do ativo ${p.ticker}: ${stockRes.reason}`);
  void taxaRes; // taxa já consumida dentro da cascata da série

  const stock = stockRes.value.data as Record<string, unknown>;
  const spot = Number(stock.close ?? stock.bid ?? stock.spot_price);
  const m9m21 = Number((stock.m9_m21 as Record<string, unknown> | undefined)?.value);
  const ivImplicita = Number(stock.iv_current);
  if (!isFinite(spot) || spot <= 0) throw new Error(`Spot inválido para ${p.ticker}`);

  const puts = extractPutsSerie(serieRes.value.data);
  if (puts.length === 0) throw new Error(`Nenhuma PUT encontrada na série de ${p.ticker}`);

  const chain = chainRes.status === "fulfilled" ? parseChain(chainRes.value.data) : new Map<string, { volume: number; close: number }>();
  if (chainRes.status === "rejected") alertas.push("Cadeia de opções indisponível — volume por opção não validado (filtro de liquidez degradado para bid/spread).");
  for (const o of puts) {
    const c = chain.get(o.symbol);
    if (c) { o.volume = c.volume; if (o.close === null && c.close > 0) o.close = c.close; }
  }

  const closes = histRes.status === "fulfilled" ? parseCloses(histRes.value.data) : [];
  const volReal = volRealizadaAnualizada(closes.slice(-Math.max(22, p.hist_days)));
  const temVolReal = isFinite(volReal) && volReal > 0;
  if (!temVolReal) alertas.push("Histórico insuficiente — Monte Carlo indisponível; decisão usa apenas delta (probabilidade risco-neutro).");

  // IV Rank (janela 252 d.u.) — se falhar vira alerta, não invenção de dado.
  let ivRank: number | null = null;
  try {
    const r = (await getIVRankHistorico(client, p.ticker, 252)) as unknown as Record<string, unknown>;
    const v = Number(r.iv_rank);
    if (isFinite(v)) ivRank = v;
  } catch { alertas.push("IV Rank indisponível — filtro de vol vendida degradado para alerta (validar manualmente)."); }

  // ── M1: Estado atual da estrutura ───────────────────────────────────────────
  const porSymbol = new Map(puts.map((o) => [o.symbol, o]));
  const pernas: PernaEstado[] = p.legs.map((l) => {
    const mkt = porSymbol.get(l.option_ticker) ?? null;
    // close=0 significa "sem negócio hoje" — não é preço válido; cai para o mid do book.
    const last = mkt ? (((mkt.close && mkt.close > 0) ? mkt.close : null) ?? (((mkt.bid + mkt.ask) / 2) || null)) : null;
    let plAcao: number | null = null;
    if (last !== null) plAcao = l.side === "VENDA" ? l.entry_price - last : last - l.entry_price;
    return {
      ...l, mercado: mkt,
      pl_por_acao: plAcao !== null ? round4(plAcao) : null,
      pl_total: plAcao !== null ? round2(plAcao * l.quantity) : null,
      alerta: mkt ? undefined : "Opção não encontrada na série atual (vencida ou ticker incorreto?)",
    };
  });

  const vendidas = pernas.filter((l) => l.side === "VENDA" && l.mercado);
  const compradas = pernas.filter((l) => l.side === "COMPRA" && l.mercado);
  if (vendidas.length === 0) throw new Error("Nenhuma perna VENDIDA localizada no mercado — manejo exige ao menos uma short put viva.");
  // Perna "doente": vendida de maior |delta| (a que dirige o risco).
  const doente = vendidas.reduce((a, b) => (Math.abs(a.mercado!.delta) >= Math.abs(b.mercado!.delta) ? a : b));
  const protecao = compradas.length > 0 ? compradas.reduce((a, b) => (a.mercado!.strike >= b.mercado!.strike ? a : b)) : null;
  const qty = doente.quantity;
  const larguraAtual = protecao ? round2(doente.mercado!.strike - protecao.mercado!.strike) : null;

  const deltaLiquido = round2(pernas.reduce((s, l) => s + (l.mercado ? (l.side === "VENDA" ? -1 : 1) * l.mercado.delta * l.quantity : 0), 0));
  // Ponderado por quantidade e expresso "por ação da vendida" (qty base).
  const creditoOriginalAcao = round4(p.legs.reduce((s, l) => s + (l.side === "VENDA" ? l.entry_price : -l.entry_price) * l.quantity, 0) / qty);
  if (protecao && protecao.quantity !== qty) {
    alertas.push(`Pernas com quantidades diferentes (vendida ${qty} × comprada ${protecao.quantity}) — trava tratada como 1:1 na qty da vendida; valores da comprada ponderados pela quantidade real. A parcela descoberta tem risco de short put a seco: validar margem.`);
  }
  const beAtual = round2(doente.mercado!.strike - Math.max(0, creditoOriginalAcao));
  // Zerar hoje (execução conservadora): recompra vendidas a ASK, vende compradas a BID.
  // Exato por perna (respeita quantidades diferentes); "por ação" = total / qty da vendida.
  const precoRecompraLeg = (l: PernaEstado) =>
    l.mercado!.ask > 0 ? l.mercado!.ask : ((l.mercado!.close && l.mercado!.close > 0) ? l.mercado!.close : 0);
  const custoZerarTotal = round2(
    vendidas.reduce((s, l) => s + precoRecompraLeg(l) * l.quantity, 0) -
    compradas.reduce((s, l) => s + l.mercado!.bid * l.quantity, 0)
  );
  const custoZerarAcao = round4(custoZerarTotal / qty);

  // Divergência delta (B-S) vs probabilidade real (vol realizada) na vendida atual.
  const mcAtual = temVolReal ? monteCarloCruzarStrike(spot, doente.mercado!.strike, volReal, doente.mercado!.dte, p.mc_paths, 42) : null;

  const estadoAtual = {
    spot: round2(spot),
    estrutura: protecao ? "BULL_PUT_SPREAD" : "SHORT_PUT_SECO",
    pernas: pernas.map((l) => ({
      option_ticker: l.option_ticker, side: l.side, quantity: l.quantity, entry_price: l.entry_price,
      strike: l.mercado?.strike ?? null, delta: l.mercado?.delta ?? null, theta: l.mercado?.theta ?? null,
      bid: l.mercado?.bid ?? null, ask: l.mercado?.ask ?? null, close: l.mercado?.close ?? null,
      volume: l.mercado?.volume ?? null, dte: l.mercado?.dte ?? null, vencimento: l.mercado?.due_date ?? null,
      moneyness: l.mercado ? (spot < l.mercado.strike ? "ITM" : spot * 0.98 <= l.mercado.strike ? "ATM" : "OTM") : null,
      pl_por_acao: l.pl_por_acao, pl_total: l.pl_total, alerta: l.alerta,
    })),
    perna_dirigindo_risco: doente.option_ticker,
    delta_liquido_acoes_equiv: deltaLiquido,
    largura_trava: larguraAtual,
    credito_original_por_acao: creditoOriginalAcao,
    breakeven_estrutura: beAtual,
    custo_zerar_hoje_por_acao: custoZerarAcao,
    custo_zerar_hoje_total: custoZerarTotal,
    divergencia_delta_vs_real: mcAtual ? {
      delta_bs_pct: pct1(Math.abs(doente.mercado!.delta)),
      prob_real_mc_pct: pct1(mcAtual.prob_terminal),
      prob_touch_mc_pct: pct1(mcAtual.prob_touch),
      leitura: Math.abs(mcAtual.prob_terminal - Math.abs(doente.mercado!.delta)) > 0.05
        ? "DELTA SUBESTIMA/SUPERESTIMA o risco real — confiar no Monte Carlo"
        : "Delta consistente com o risco medido no histórico",
    } : null,
  };

  // ── M2: Gerador de candidatos ───────────────────────────────────────────────
  const vencAlvo = [...new Set(
    puts.filter((o) => o.dte >= p.dte_min && o.dte <= p.dte_max && o.due_date > doente.mercado!.due_date).map((o) => o.due_date)
  )].sort().slice(0, 2);
  if (vencAlvo.length === 0) alertas.push(`Nenhum vencimento na janela ${p.dte_min}-${p.dte_max} DTE após ${doente.mercado!.due_date} — ajuste dte_min/dte_max.`);

  interface Bruto { tipo: Candidato["tipo"]; venda: OpcaoMercado; compra: OpcaoMercado | null; mantemProt: boolean; desc: string }
  const brutos: Bruto[] = [];
  for (const due of vencAlvo) {
    const doVenc = puts.filter((o) => o.due_date === due);
    // (a) CALENDÁRIO: mesmo strike (tolerância 2%)
    const mesmoStrike = doVenc
      .filter((o) => Math.abs(o.strike - doente.mercado!.strike) / doente.mercado!.strike <= 0.02)
      .sort((a, b) => Math.abs(a.strike - doente.mercado!.strike) - Math.abs(b.strike - doente.mercado!.strike))[0];
    // (b) DEFENSIVA: strikes com delta na banda alvo — até 2 por vencimento (menor |delta| primeiro)
    const defensivas = doVenc
      .filter((o) => o.delta >= p.delta_novo_min && o.delta <= p.delta_novo_max && o.bid > 0)
      .sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta)).slice(0, 2);

    for (const venda of [mesmoStrike, ...defensivas].filter(Boolean) as OpcaoMercado[]) {
      const tipoBase: Candidato["tipo"] = venda === mesmoStrike ? "CALENDARIO" : "DEFENSIVA";
      if (protecao) {
        // (i) manter proteção atual — só se ela vence DEPOIS (ou junto) do novo ciclo
        if (protecao.mercado!.due_date >= due && protecao.mercado!.strike < venda.strike) {
          brutos.push({ tipo: tipoBase, venda, compra: null, mantemProt: true, desc: `Rolar só a vendida p/ ${venda.symbol} (${due}); manter proteção ${protecao.option_ticker}` });
        }
        // (ii) rolar a trava inteira com a MESMA largura
        const alvo = venda.strike - (larguraAtual ?? 0);
        const novaProt = doVenc.filter((o) => o.strike < venda.strike).sort((a, b) => Math.abs(a.strike - alvo) - Math.abs(b.strike - alvo))[0];
        if (novaProt) brutos.push({ tipo: tipoBase, venda, compra: novaProt, mantemProt: false, desc: `Rolar trava inteira p/ ${venda.symbol}/${novaProt.symbol} (${due}), largura ~${round2(venda.strike - novaProt.strike)}` });
        // (iii) LARGURA maior (proteção 1 strike mais distante) — reduz custo da asa
        const protecoesAbaixo = doVenc.filter((o) => o.strike < alvo).sort((a, b) => b.strike - a.strike);
        if (protecoesAbaixo[0] && novaProt && protecoesAbaixo[0].symbol !== novaProt.symbol) {
          brutos.push({ tipo: "LARGURA", venda, compra: protecoesAbaixo[0], mantemProt: false, desc: `Rolar alargando a trava p/ ${venda.symbol}/${protecoesAbaixo[0].symbol} (${due})` });
        }
      } else {
        brutos.push({ tipo: tipoBase, venda, compra: null, mantemProt: false, desc: `Rolar short put a seco p/ ${venda.symbol} (${due})` });
      }
    }
  }
  // dedup por (venda, compra, mantemProt)
  const vistos = new Set<string>();
  const unicos = brutos.filter((b) => {
    const k = `${b.venda.symbol}|${b.compra?.symbol ?? (b.mantemProt ? "KEEP" : "NAKED")}`;
    if (vistos.has(k)) return false;
    vistos.add(k);
    return true;
  }).slice(0, 12);

  // ── M3 + M4 + M5: precificar, validar estatística, filtrar ─────────────────
  const custoRecompra = doente.mercado!.ask > 0 ? doente.mercado!.ask : ((doente.mercado!.close && doente.mercado!.close > 0) ? doente.mercado!.close : 0);
  if (doente.mercado!.ask <= 0) alertas.push(`ASK da ${doente.option_ticker} indisponível — recompra estimada pelo close (validar na corretora).`);
  const deltaAtualAbs = Math.abs(doente.mercado!.delta);
  const mcCache = new Map<string, MonteCarloResult>();

  const candidatos: Candidato[] = unicos.map((b, i) => {
    // crédito executável por ação
    let cred = b.venda.bid - custoRecompra;
    if (protecao && !b.mantemProt) cred += protecao.mercado!.bid * (protecao.quantity / qty); // vende a proteção antiga (ponderado pela qty real dela)
    if (b.compra) cred -= (b.compra.ask > 0 ? b.compra.ask : ((b.compra.close && b.compra.close > 0) ? b.compra.close : 0)); // compra a proteção nova
    const credTotal = round2(cred * qty);

    const largura = b.compra ? b.venda.strike - b.compra.strike : (b.mantemProt && protecao ? b.venda.strike - protecao.mercado!.strike : null);
    const riscoMax = largura !== null ? round2((largura - cred) * qty) : null;
    const beNovo = round2(b.venda.strike - Math.max(0, cred));

    // Monte Carlo (cacheado por strike|dte)
    let mc: MonteCarloResult | null = null;
    if (temVolReal) {
      const k = `${b.venda.strike}|${b.venda.dte}`;
      if (!mcCache.has(k)) mcCache.set(k, monteCarloCruzarStrike(spot, b.venda.strike, volReal, b.venda.dte, p.mc_paths, 42));
      mc = mcCache.get(k)!;
    }
    const probFechada = temVolReal ? probTerminalFechada(spot, b.venda.strike, volReal, b.venda.dte) : null;

    const cand: Candidato = {
      id: `C${i + 1}`,
      tipo: b.compra === null && !b.mantemProt && protecao ? "SEM_PROTECAO" : b.tipo,
      descricao: b.desc,
      vencimento: b.venda.due_date,
      dte: b.venda.dte,
      nova_vendida: { symbol: b.venda.symbol, strike: b.venda.strike, delta: round4(b.venda.delta), bid: b.venda.bid, ask: b.venda.ask, volume: b.venda.volume },
      nova_comprada: b.compra ? { symbol: b.compra.symbol, strike: b.compra.strike, delta: round4(b.compra.delta), bid: b.compra.bid, ask: b.compra.ask, volume: b.compra.volume } : null,
      mantem_protecao_atual: b.mantemProt,
      credito_liquido_por_acao: round4(cred),
      credito_liquido_total: credTotal,
      delta_pos_rolagem: round4(b.venda.delta),
      theta_dia_por_acao: b.venda.theta !== null ? round4(Math.abs(b.venda.theta)) : (b.venda.close ? round4(b.venda.close / Math.max(1, b.venda.dte)) : null),
      breakeven_novo: beNovo,
      distancia_be_spot_pct: pct1((spot - beNovo) / spot),
      risco_maximo_total: riscoMax,
      notional_risco: round2(b.venda.strike * qty),
      prob_mc_exercicio_pct: mc ? pct1(mc.prob_terminal) : null,
      prob_mc_touch_pct: mc ? pct1(mc.prob_touch) : null,
      prob_formula_fechada_pct: probFechada !== null ? pct1(probFechada) : null,
      status: "APROVADO",
      motivo_eliminacao: null,
      score: null,
    };

    // ── M5: filtros hard (primeiro que reprovar elimina, com motivo exato) ────
    const spreadPct = b.venda.bid > 0 && b.venda.ask > 0 ? ((b.venda.ask - b.venda.bid) / ((b.venda.ask + b.venda.bid) / 2)) * 100 : null;
    const elimina = (motivo: string) => { cand.status = "ELIMINADO"; cand.motivo_eliminacao = motivo; };

    if (custoRecompra <= 0) elimina("dados_incompletos — sem ask/close válido para precificar a recompra da vendida (verificar na corretora)");
    else if (cred <= 0) elimina(`crédito_negativo (${round4(cred)}/ação) — rolagem a débito é proibida`);
    else if (Math.abs(b.venda.delta) >= deltaAtualAbs) elimina(`delta_não_reduz (novo ${round4(Math.abs(b.venda.delta))} ≥ atual ${round4(deltaAtualAbs)}) — regra de ouro`);
    else if (Math.abs(b.venda.delta) > 0.70) elimina("delta_acima_de_0.70 — proibido para short put");
    else if (isFinite(m9m21) && m9m21 < 1.0) elimina(`tendência_contra (M9/M21=${round2(m9m21)} < 1,00) — não rolar em tendência baixista`);
    else if (b.venda.bid <= 0) elimina("sem_bid — liquidez inexistente na nova vendida");
    else if (spreadPct !== null && spreadPct > p.spread_max_pct) elimina(`spread_alto (${round2(spreadPct)}% > ${p.spread_max_pct}%)`);
    else if (b.venda.volume !== null && b.venda.volume < p.volume_min) elimina(`volume_baixo (${b.venda.volume} < ${p.volume_min} contratos)`);
    else if (ivRank !== null && ivRank < p.iv_rank_min) elimina(`iv_rank_baixo (${round2(ivRank)} < ${p.iv_rank_min}) — vendendo volatilidade barata`);
    else if (cand.tipo === "SEM_PROTECAO") elimina("remove_proteção — transformaria trava em short put a seco (só permitido com aprovação explícita: rode com legs sem a perna comprada)");

    return cand;
  });

  // ── M6: score e decisão ─────────────────────────────────────────────────────
  const aprovados = candidatos.filter((c) => c.status === "APROVADO");
  for (const c of aprovados) {
    const roic = c.risco_maximo_total !== null ? c.credito_liquido_total / Math.max(c.risco_maximo_total, 0.01 * c.notional_risco) : c.credito_liquido_total / c.notional_risco;
    const pSobrevive = c.prob_mc_exercicio_pct !== null ? 1 - c.prob_mc_exercicio_pct / 100 : 1 - Math.abs(c.delta_pos_rolagem);
    const theta = c.theta_dia_por_acao ?? 0.001;
    c.score = round4(roic * theta * qty * pSobrevive);
  }
  aprovados.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  const vencedor = aprovados[0] ?? null;
  const decisao = vencedor
    ? {
        acao: "ROLAR",
        candidato: vencedor.id,
        racional: `Melhor score entre ${aprovados.length} aprovado(s) de ${candidatos.length} candidato(s): crédito R$ ${vencedor.credito_liquido_total}, delta ${vencedor.delta_pos_rolagem} (vs ${round4(-deltaAtualAbs)} atual), P(exercício real) ${vencedor.prob_mc_exercicio_pct ?? "n/d"}%.`,
        plano_execucao: [
          `1. COMPRAR (fechar) ${qty} ${doente.option_ticker} a ~R$ ${custoRecompra} (ask)`,
          ...(protecao && !vencedor.mantem_protecao_atual ? [`2. VENDER (fechar) ${protecao.quantity} ${protecao.option_ticker} a ~R$ ${protecao.mercado!.bid} (bid)`] : []),
          `${protecao && !vencedor.mantem_protecao_atual ? 3 : 2}. VENDER (abrir) ${qty} ${vencedor.nova_vendida.symbol} a ~R$ ${vencedor.nova_vendida.bid} (bid)`,
          ...(vencedor.nova_comprada ? [`${protecao && !vencedor.mantem_protecao_atual ? 4 : 3}. COMPRAR (abrir) ${qty} ${vencedor.nova_comprada.symbol} a ~R$ ${vencedor.nova_comprada.ask} (ask)`] : []),
          `Resultado esperado: crédito líquido ~R$ ${vencedor.credito_liquido_total} | novo BE R$ ${vencedor.breakeven_novo} | validar margem na corretora antes de executar`,
        ],
      }
    : {
        acao: "NAO_ROLAR — decidir entre ASSUMIR ou ENCERRAR",
        candidato: null,
        racional: `Nenhum candidato sobreviveu aos filtros (${candidatos.length} avaliados — ver motivo_eliminacao de cada um). Rolagem a crédito com redução de delta não existe neste momento.`,
        plano_execucao: [
          `OPÇÃO A — ENCERRAR: zerar a estrutura hoje custa ~R$ ${custoZerarTotal} (${round4(custoZerarAcao)}/ação, execução a mercado).`,
          `OPÇÃO B — ASSUMIR: aguardar exercício da ${doente.option_ticker}: compra de ${qty} ${p.ticker} a R$ ${doente.mercado!.strike} (desembolso R$ ${round2(doente.mercado!.strike * qty)}); perda máxima segue travada${larguraAtual ? ` em R$ ${round2((larguraAtual - creditoOriginalAcao) * qty)} pela proteção` : " apenas pelo strike (short put a seco)"}.`,
          "Reavaliar diariamente: um repique do spot ou nova série listada pode reabrir candidato a crédito.",
        ],
      };

  return {
    ticker: p.ticker,
    parametros: p,
    mercado: {
      spot: round2(spot),
      m9_m21: isFinite(m9m21) ? round2(m9m21) : null,
      tendencia: isFinite(m9m21) ? (m9m21 >= 1 ? "ALTA" : "BAIXA") : "n/d",
      iv_implicita_atual: isFinite(ivImplicita) ? round2(ivImplicita) : null,
      vol_realizada_anualizada: temVolReal ? round2(volReal * 100) : null,
      iv_vs_realizada: temVolReal && isFinite(ivImplicita)
        ? (ivImplicita < volReal * 100 ? "IV ABAIXO da vol realizada — mercado cobra prêmio MENOR que o risco histórico (delta otimista)" : "IV acima da vol realizada — prêmios pagam o risco histórico")
        : null,
      iv_rank_252d: ivRank,
      candles_historico: closes.length,
      mc_paths: p.mc_paths,
    },
    estado_atual: estadoAtual,
    candidatos,
    ranking_aprovados: aprovados.map((c) => ({ id: c.id, descricao: c.descricao, score: c.score, credito_total: c.credito_liquido_total, delta_novo: c.delta_pos_rolagem, prob_exercicio_pct: c.prob_mc_exercicio_pct })),
    decisao,
    alertas,
    disclaimer: "Preços executáveis estimados por bid/ask do último book. Validar prêmios, margem e colchão (≥15%) na corretora antes de executar. Esta análise não é recomendação de investimento.",
  };
}
