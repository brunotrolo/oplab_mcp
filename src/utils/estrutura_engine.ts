// ─────────────────────────────────────────────────────────────────────────────
// estrutura_engine.ts — get_analise_estrutura
//
// Classifica a FASE de preço de um ticker a partir do OHLC histórico real
// (ALTA / BAIXA / LATERAL / TRANSIÇÃO), antecipando viradas que o M9/M21 confirma
// tarde. Números crus e DETERMINÍSTICOS — não dá sinal de compra/venda nem prevê
// o futuro. Mesmas regras de design do get_analise_manejo:
//  • cálculo pelo close/OHLC, a qualquer hora;
//  • não gerencia patrimônio/strike/concentração;
//  • mesma entrada ⇒ mesma saída sempre.
// ─────────────────────────────────────────────────────────────────────────────

import { AxiosInstance } from "axios";

const REQUEST_TIMEOUT_MS = 25_000;
const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number; }
interface Pivot { index: number; value: number; }

function parseCandles(raw: unknown): Candle[] {
  const obj = raw as Record<string, unknown> | undefined;
  const arr = Array.isArray(raw) ? raw : Array.isArray(obj?.data) ? (obj!.data as unknown[]) : [];
  const out: Candle[] = [];
  for (const c of arr) {
    const o = c as Record<string, unknown>;
    const close = Number(o.close), high = Number(o.high), low = Number(o.low), open = Number(o.open), vol = Number(o.volume), time = Number(o.time);
    if (isFinite(close) && close > 0 && isFinite(high) && isFinite(low))
      out.push({ time: isFinite(time) ? time : 0, open: isFinite(open) ? open : close, high, low, close, volume: isFinite(vol) ? vol : 0 });
  }
  return out;
}

/** Média móvel simples dos `period` closes terminando em endIdx (inclusive). */
function sma(arr: number[], period: number, endIdx: number): number | null {
  if (endIdx + 1 < period) return null;
  let s = 0;
  for (let i = endIdx - period + 1; i <= endIdx; i++) s += arr[i];
  return s / period;
}

/** Pivôs com janela k: candle i é topo se high[i] > vizinhos nos k lados. */
function swingHighs(c: Candle[], k = 3): Pivot[] {
  const out: Pivot[] = [];
  for (let i = k; i < c.length - k; i++) {
    let ok = true;
    for (let j = 1; j <= k; j++) if (!(c[i].high > c[i - j].high && c[i].high > c[i + j].high)) { ok = false; break; }
    if (ok) out.push({ index: i, value: round2(c[i].high) });
  }
  return out;
}
function swingLows(c: Candle[], k = 3): Pivot[] {
  const out: Pivot[] = [];
  for (let i = k; i < c.length - k; i++) {
    let ok = true;
    for (let j = 1; j <= k; j++) if (!(c[i].low < c[i - j].low && c[i].low < c[i + j].low)) { ok = false; break; }
    if (ok) out.push({ index: i, value: round2(c[i].low) });
  }
  return out;
}

/** Fase de uma janela [start,end): LATERAL se amplitude<4%; ALTA se incl>3%; BAIXA se <−3%. */
function faseWindow(c: Candle[], start: number, end: number): { fase: string; amplitude: number; inclinacao: number } {
  const seg = c.slice(Math.max(0, start), end);
  const closes = seg.map((x) => x.close);
  const max = Math.max(...seg.map((x) => x.high));
  const min = Math.min(...seg.map((x) => x.low));
  const media = closes.reduce((a, b) => a + b, 0) / closes.length;
  const amplitude = media > 0 ? ((max - min) / media) * 100 : 0;
  const ini = closes[0], fim = closes[closes.length - 1];
  const inclinacao = ini > 0 ? ((fim - ini) / ini) * 100 : 0;
  let fase = "LATERAL";
  if (amplitude < 4) fase = "LATERAL";
  else if (inclinacao > 3) fase = "ALTA";
  else if (inclinacao < -3) fase = "BAIXA";
  else fase = "LATERAL";
  return { fase, amplitude: round2(amplitude), inclinacao: round2(inclinacao) };
}

export async function getAnaliseEstrutura(client: AxiosInstance, args: Record<string, unknown>): Promise<unknown> {
  const symbol = String(args.symbol ?? "").toUpperCase();
  if (!symbol) throw new Error("Parâmetro obrigatório: symbol (ex: PSSA3)");
  const lookback = Math.max(30, Math.round(Number(args.lookback_days) || 90));

  const to = new Date();
  const from = new Date(to.getTime() - lookback * 86_400_000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  let raw: unknown = null;
  try { raw = (await client.get(`/market/historical/${symbol}/1d`, { params: { from: fmt(from), to: fmt(to) }, timeout: REQUEST_TIMEOUT_MS })).data; }
  catch { return { erro: "DADOS INCOMPLETOS" }; }

  const candles = parseCandles(raw);
  if (candles.length < 30) return { erro: "DADOS INCOMPLETOS" };

  const n = candles.length;
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const vols = candles.map((c) => c.volume);

  // (1) Swings — últimos 3 topos e 3 fundos
  const tops = swingHighs(candles, 3);
  const bottoms = swingLows(candles, 3);
  const ultimos_topos = tops.slice(-3).map((p) => ({ index: p.index, value: p.value }));
  const ultimos_fundos = bottoms.slice(-3).map((p) => ({ index: p.index, value: p.value }));

  // (2) Estrutura de tendência
  const fundos_ascendentes = bottoms.length >= 2 && bottoms[bottoms.length - 1].value > bottoms[bottoms.length - 2].value;
  const topos_ascendentes = tops.length >= 2 && tops[tops.length - 1].value > tops[tops.length - 2].value;
  const estrutura_tendencia = fundos_ascendentes && topos_ascendentes ? "ALTA_ESTRUTURAL" : (!fundos_ascendentes && !topos_ascendentes ? "BAIXA_ESTRUTURAL" : "INDEFINIDA");

  // (3) Fase — recente (últimos 15) vs anterior/meio (15 antes)
  const W = 15;
  const recent = faseWindow(candles, n - W, n);
  const mid = faseWindow(candles, n - 2 * W, n - W);

  // (4) Rompimento — N=20 candles anteriores (exclui o atual)
  const N = 20;
  const prevStart = Math.max(0, n - 1 - N);
  const max20 = Math.max(...highs.slice(prevStart, n - 1));
  const min20 = Math.min(...lows.slice(prevStart, n - 1));
  const close = closes[n - 1];
  const rompeu_alta = close > max20;
  const rompeu_baixa = close < min20;
  const pct_rompimento = rompeu_alta ? round2(((close - max20) / max20) * 100)
    : rompeu_baixa ? round2(((close - min20) / min20) * 100)
    : round2(((close - max20) / max20) * 100); // negativo = quão abaixo da máxima de 20d

  // (5) Volume nos pivôs
  const vol_ultimo = vols[n - 1];
  const janelaVol = vols.slice(Math.max(0, n - 20));
  const vol_media_20d = round2(janelaVol.reduce((a, b) => a + b, 0) / janelaVol.length);
  const volume_confirma = vol_ultimo > vol_media_20d;

  // (6) TRANSIÇÃO — fase anterior LATERAL (amplitude<4%) + rompimento recente + volume confirma
  const transicao_detectada = mid.amplitude < 4 && (rompeu_alta || rompeu_baixa) && volume_confirma;
  const transicao_direcao = transicao_detectada ? (rompeu_alta ? "ALTA" : "BAIXA") : null;

  const fase_atual = transicao_detectada ? "TRANSIÇÃO" : recent.fase;

  // (7) Contexto M9/M21 + dias de antecipação da estrutura
  const m9 = sma(closes, 9, n - 1);
  const m21 = sma(closes, 21, n - 1);
  const m9m21_ratio = m9 !== null && m21 !== null && m21 !== 0 ? round4(m9 / m21) : null;

  let dias_antecipacao: number | null = null;
  let ascIdx: number | null = null;
  for (let i = 1; i < bottoms.length; i++) if (bottoms[i].value > bottoms[i - 1].value) { ascIdx = bottoms[i].index; break; }
  if (ascIdx !== null && n >= 22) {
    let crossIdx: number | null = null;
    for (let i = 21; i < n; i++) {
      const a9p = sma(closes, 9, i - 1), a21p = sma(closes, 21, i - 1), a9 = sma(closes, 9, i), a21 = sma(closes, 21, i);
      if (a9p !== null && a21p !== null && a9 !== null && a21 !== null && a9p <= a21p && a9 > a21) crossIdx = i; // guarda o cruzamento de alta mais recente
    }
    if (crossIdx !== null && crossIdx >= ascIdx) dias_antecipacao = crossIdx - ascIdx;
  }

  return {
    symbol,
    fase_atual,
    fundos_ascendentes,
    topos_ascendentes,
    estrutura_tendencia,
    ultimos_topos,
    ultimos_fundos,
    rompeu_alta,
    rompeu_baixa,
    pct_rompimento,
    volume_confirma,
    vol_ultimo,
    vol_media_20d,
    transicao_detectada,
    transicao_direcao,
    m9: m9 !== null ? round2(m9) : null,
    m21: m21 !== null ? round2(m21) : null,
    m9m21_ratio,
    dias_antecipacao,
    fase_recente: recent,
    fase_anterior: mid,
    candles_analisados: n,
    snapshot_timestamp: new Date().toISOString(),
    base_calculo: "Estrutura de preço pelo OHLC/close. Classificação factual — não é sinal de compra/venda nem previsão. Motor não avalia patrimônio.",
  };
}
