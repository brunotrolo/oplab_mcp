// ---------------------------------------------------------------------------
// IV Rank calculator — funções puras de volatilidade + orquestração com cache
//
// Mantido em arquivo SEPARADO de src/index.ts de propósito: a matemática e as
// chamadas em lote ficam isoladas para que index.ts continue enxuto e o
// transporte SSE estável (ver CLAUDE.md / .claude/rules).
//
// Fonte da volatilidade implícita "atual":
//   A rota /market/options/{ticker} (chain completa) NÃO expõe implied_volatility
//   e chega a ~4MB por ativo — inviável para o bulk de 24 ativos. A OpLab já
//   calcula a IV corrente do ativo no campo `iv_current` de /market/stocks/{ticker}
//   (payload pequeno). Usamos esse campo como `iv_atual` (iv_fonte="implicita").
//   Sem ele, caímos para a vol. realizada de 21d mais recente (iv_fonte="historica").
// ---------------------------------------------------------------------------

import { AxiosInstance } from "axios";

// ── Funções matemáticas puras (sem dependências além de Math) ───────────────

/** Retornos logarítmicos: ln(close_hoje / close_ontem). */
export function calcRetornosLog(precos: number[]): number[] {
  const retornos: number[] = [];
  for (let i = 1; i < precos.length; i++) {
    const ontem = precos[i - 1];
    const hoje = precos[i];
    retornos.push(ontem > 0 && hoje > 0 ? Math.log(hoje / ontem) : 0);
  }
  return retornos;
}

/**
 * Volatilidade realizada anualizada (%) na janela rolling de 21 dias terminando
 * em `index` (inclusive): std(retornos[index-20..index]) × sqrt(252) × 100.
 * Usa desvio-padrão amostral (n-1).
 */
export function calcVolatilidade21d(retornos: number[], index: number): number {
  const inicio = index - 20;
  if (inicio < 0 || index >= retornos.length) return 0;
  const janela = retornos.slice(inicio, index + 1);
  if (janela.length < 2) return 0;
  const media = janela.reduce((s, r) => s + r, 0) / janela.length;
  const variancia = janela.reduce((s, r) => s + (r - media) ** 2, 0) / (janela.length - 1);
  return Math.sqrt(variancia) * Math.sqrt(252) * 100;
}

/** IV Rank: (iv_atual - min) / (max - min) × 100. */
export function calcIVRank(ivAtual: number, serie: number[]): number {
  if (serie.length === 0) return 0;
  const min = Math.min(...serie);
  const max = Math.max(...serie);
  if (max === min) return 0;
  return ((ivAtual - min) / (max - min)) * 100;
}

/** IV Percentile: % de dias da série com vol < iv_atual. */
export function calcIVPercentile(ivAtual: number, serie: number[]): number {
  if (serie.length === 0) return 0;
  const count = serie.filter((v) => v < ivAtual).length;
  return (count / serie.length) * 100;
}

export interface Classificacao {
  nivel: string;
  sinal: string;
}

/** Classifica o IV Rank em nível operacional + sinal. */
export function classificarIVRank(ivRank: number): Classificacao {
  if (ivRank >= 70) return { nivel: "MUITO_ALTA", sinal: "EXCELENTE — Vender opções agora" };
  if (ivRank >= 50) return { nivel: "ALTA", sinal: "BOM — Momento favorável para vender" };
  if (ivRank >= 30) return { nivel: "MEDIA", sinal: "NEUTRO — Avaliar outros filtros" };
  return { nivel: "BAIXA", sinal: "EVITAR — IV abaixo da média histórica" };
}

// ── Helpers internos ────────────────────────────────────────────────────────

const round1 = (n: number): number => Math.round(n * 10) / 10;
const mean = (arr: number[]): number => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0);
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** Converte timestamp (s ou ms) para "YYYY-MM-DD" (UTC). */
function toDateStr(t: number): string {
  if (!isFinite(t) || t <= 0) return "";
  const ms = t < 1e12 ? t * 1000 : t;
  return new Date(ms).toISOString().slice(0, 10);
}

interface Candle {
  date: string;
  close: number;
}

/** Extrai candles {date, close} da resposta de /market/historical. */
function extractCandles(raw: unknown): Candle[] {
  const obj = raw as Record<string, unknown> | undefined;
  const rows = Array.isArray(raw) ? raw : (obj && Array.isArray(obj.data) ? (obj.data as unknown[]) : []);
  return rows
    .map((row): Candle => {
      const r = row as Record<string, unknown>;
      const close = Number(r.close ?? r.c ?? r.price);
      const rawDate = r.date ?? r.datetime;
      const date = typeof rawDate === "string" ? rawDate.slice(0, 10) : toDateStr(Number(r.time ?? r.t ?? r.timestamp));
      return { date, close };
    })
    .filter((c) => isFinite(c.close) && c.close > 0);
}

/** Normaliza um valor de IV para escala percentual (24.69 → 24.69; 0.2469 → 24.69). */
function toPercent(iv: number): number {
  if (!isFinite(iv) || iv <= 0) return 0;
  return iv < 3 ? iv * 100 : iv;
}

/** Formata número em escala % com 1 casa e vírgula decimal (pt-BR): 71.5 → "71,5". */
function fmtComma(n: number): string {
  return round1(n).toFixed(1).replace(".", ",");
}

export interface ConsensoInfo {
  consenso: string;
  consenso_sinal: string;
  consenso_confianca: string;
}

/**
 * Consenso entre as janelas de 63d e 126d (as duas mais relevantes operacionalmente).
 * Confirma o sinal quando AMBAS cruzam o mesmo limiar; caso contrário, DIVERGENTE.
 */
export function calcConsenso(r63: number, r126: number): ConsensoInfo {
  if (r63 >= 70 && r126 >= 70)
    return { consenso: "MUITO_ALTA", consenso_sinal: "EXCELENTE — Sinal confirmado em múltiplos períodos", consenso_confianca: "ALTA" };
  if (r63 >= 50 && r126 >= 50)
    return { consenso: "ALTA", consenso_sinal: "BOM — Sinal confirmado em múltiplos períodos", consenso_confianca: "ALTA" };
  if (r63 >= 30 && r126 >= 30)
    return { consenso: "MEDIA", consenso_sinal: "NEUTRO — Avaliar outros filtros", consenso_confianca: "MEDIA" };
  if (r63 < 30 && r126 < 30)
    return { consenso: "BAIXA", consenso_sinal: "EVITAR — IV baixa confirmada", consenso_confianca: "ALTA" };
  return {
    consenso: "DIVERGENTE",
    consenso_sinal: "INCONCLUSIVO — Períodos divergem. Usar iv_rank_63d como referência para operações de curto prazo.",
    consenso_confianca: "BAIXA",
  };
}

// ── Cache em memória (TTL 4h) ───────────────────────────────────────────────

const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 horas
const ivCache = new Map<string, { data: IVRankResult; timestamp: number }>();

/** Limpa o cache (útil em testes). */
export function clearIVCache(): void {
  ivCache.clear();
}

// ── Concorrência limitada — lotes de N com delay entre lotes ────────────────

/**
 * Processa `items` em lotes de `batchSize` (Promise.all dentro do lote),
 * aguardando `delayMs` entre lotes. Evita HTTP 429 da OpLab.
 */
export async function batchWithLimit<T, R>(
  items: T[],
  worker: (item: T) => Promise<R>,
  batchSize = 3,
  delayMs = 300
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(worker));
    results.push(...batchResults);
    if (i + batchSize < items.length) {
      await new Promise<void>((r) => setTimeout(r, delayMs));
    }
  }
  return results;
}

// ── Tipos de resultado ──────────────────────────────────────────────────────

export interface HistoricoMensal {
  mes: string;
  iv_media: number;
  iv_max: number;
}

export interface MultiPeriodo {
  iv_rank_21d: number;
  iv_rank_63d: number;
  iv_rank_126d: number;
  iv_rank_252d: number;
}

export interface IVRankResult {
  ticker: string;
  periodo_dias: number;
  data_referencia: string;
  iv_atual: number;
  iv_fonte: "implicita" | "historica";
  iv_min_periodo: number;
  iv_max_periodo: number;
  iv_media_periodo: number;
  iv_rank: number;
  iv_percentile: number;
  classificacao: string;
  sinal_operacional: string;
  // Ajuste 1 — alerta de histórico insuficiente
  historico_insuficiente: boolean;
  dias_disponiveis: number;
  aviso?: string;
  // Ajuste 2 — multi-período e consenso
  multi_periodo: MultiPeriodo;
  consenso: string;
  consenso_sinal: string;
  consenso_confianca: string;
  // Ajuste 3 — detecção de evento corporativo
  alerta_evento: boolean;
  alerta_evento_msg?: string;
  cache_hit: boolean;
  historico_mensal: HistoricoMensal[];
}

/** Mínimo de dias úteis para o IV Rank ser considerado confiável. */
const MIN_DIAS_CONFIAVEL = 126;

/** Whitelist padrão de 24 ativos líquidos para o bulk. */
export const WHITELIST_24 = [
  "B3SA3", "BBAS3", "BBDC4", "BRAV3", "BRKM5", "CMIG4",
  "CMIN3", "COGN3", "CSAN3", "CSNA3", "DIRR3", "EMBJ3",
  "FLRY3", "GGBR4", "ITSA4", "ITUB4", "NATU3", "PETR4",
  "PRIO3", "PSSA3", "SANB11", "SUZB3", "USIM5", "VALE3",
];

const PERIODOS_VALIDOS = [21, 63, 126, 252];

/** Normaliza o parâmetro `periodo` (default 252; aceita 21, 63, 126, 252). */
export function normalizarPeriodo(periodo: unknown): number {
  const n = Number(periodo);
  if (Number.isFinite(n) && PERIODOS_VALIDOS.includes(n)) return n;
  return 252;
}

// ── Orquestração ─────────────────────────────────────────────────────────────

/**
 * Calcula IV Rank/Percentile históricos de um ticker.
 * Verifica o cache (TTL 4h) antes de chamar a OpLab.
 * Lança erro em falha dura (sem histórico) — o bulk captura por ativo.
 */
export async function getIVRankHistorico(
  client: AxiosInstance,
  ticker: string,
  periodo: number
): Promise<IVRankResult> {
  const tk = ticker.toUpperCase();
  const cacheKey = `${tk}_${periodo}`;

  const cached = ivCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return { ...cached.data, cache_hit: true };
  }

  // Janela de calendário suficiente para ~periodo dias úteis de vol_21d
  // (≈0,69 dia útil por dia de calendário) + a janela rolling de 21d + folga.
  const calendarDays = Math.ceil((periodo + 25) / 0.69) + 15;
  const to = new Date();
  const from = new Date(to.getTime() - calendarDays * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  const { data: histRaw } = await client.get(`/market/historical/${tk}/1d`, {
    params: { from: fmt(from), to: fmt(to) },
  });
  const candles = extractCandles(histRaw);
  if (candles.length < 23) {
    throw new Error(`Histórico insuficiente para ${tk} (${candles.length} candles)`);
  }

  const closes = candles.map((c) => c.close);
  const dates = candles.map((c) => c.date);
  const retornos = calcRetornosLog(closes);

  // Série de vol_21d. retornos[i] refere-se a closes[i+1], logo a data é dates[i+1].
  const volAll: number[] = [];
  const volDates: string[] = [];
  for (let i = 20; i < retornos.length; i++) {
    volAll.push(calcVolatilidade21d(retornos, i));
    volDates.push(dates[i + 1] ?? dates[dates.length - 1]);
  }
  if (volAll.length === 0) {
    throw new Error(`Não foi possível calcular volatilidade para ${tk}`);
  }

  // Mantém os últimos `periodo` valores (IV rank sobre a janela pedida).
  const serie = volAll.slice(-periodo);
  const serieDates = volDates.slice(-periodo);
  const ultimaVol = serie[serie.length - 1];

  // IV atual: implícita (iv_current da ação) ou, na falta, vol realizada recente.
  let ivAtual = round1(ultimaVol);
  let ivFonte: "implicita" | "historica" = "historica";
  try {
    const { data: stock } = await client.get(`/market/stocks/${tk}`);
    const ivCurrent = toPercent(Number((stock as Record<string, unknown>)?.iv_current));
    if (ivCurrent > 0) {
      ivAtual = round1(ivCurrent);
      ivFonte = "implicita";
    }
  } catch {
    // mantém fallback histórico
  }

  // Dias úteis de dados (candles) disponíveis — base para os alertas de histórico curto.
  const diasDisponiveis = candles.length;

  const ivMedia = round1(mean(serie));
  const ivRank = clamp(calcIVRank(ivAtual, serie), 0, 100);
  const ivPercentile = clamp(calcIVPercentile(ivAtual, serie), 0, 100);
  let { nivel, sinal } = classificarIVRank(ivRank);

  // Ajuste 2 — multi-período: IV Rank nas 4 janelas, reaproveitando volAll (sem nova chamada).
  const rankFor = (n: number) => round1(clamp(calcIVRank(ivAtual, volAll.slice(-n)), 0, 100));
  const multi_periodo: MultiPeriodo = {
    iv_rank_21d: rankFor(21),
    iv_rank_63d: rankFor(63),
    iv_rank_126d: rankFor(126),
    iv_rank_252d: rankFor(252),
  };
  const { consenso, consenso_sinal, consenso_confianca } = calcConsenso(
    multi_periodo.iv_rank_63d,
    multi_periodo.iv_rank_126d
  );

  // Ajuste 3 — evento corporativo: IV atual mais que 2× a média histórica do período.
  let alerta_evento = false;
  let alerta_evento_msg: string | undefined;
  if (ivMedia > 0 && ivAtual > ivMedia * 2.0) {
    alerta_evento = true;
    alerta_evento_msg =
      `IV atual (${fmtComma(ivAtual)}%) é mais que 2× a média histórica (${fmtComma(ivMedia)}%). ` +
      `Possível evento corporativo ou distorção de dados. Verificar notícias antes de operar.`;
    // classificacao mantém o calculado; só o sinal operacional muda.
    sinal = "⚠️ VERIFICAR EVENTO — IV anormalmente alta. Confirmar antes de operar.";
  }

  // Ajuste 1 — histórico insuficiente: tem prioridade sobre os demais sinais.
  let historico_insuficiente = false;
  let aviso: string | undefined;
  if (diasDisponiveis < MIN_DIAS_CONFIAVEL) {
    historico_insuficiente = true;
    aviso =
      "Histórico < 126 dias úteis — IV Rank pode estar distorcido. " +
      "Usar com cautela ou aguardar mais dados históricos.";
    nivel = "INSUFICIENTE";
    sinal = "DADOS INSUFICIENTES — Verificar manualmente";
  } else if (diasDisponiveis < periodo) {
    aviso =
      `Período solicitado: ${periodo} dias. Disponível: ${diasDisponiveis} dias. ` +
      `IV Rank calculado com dados parciais.`;
  }

  // Histórico mensal: média e máximo da vol_21d por mês.
  const byMonth = new Map<string, number[]>();
  serie.forEach((v, i) => {
    const mes = (serieDates[i] ?? "").slice(0, 7);
    if (!mes) return;
    if (!byMonth.has(mes)) byMonth.set(mes, []);
    byMonth.get(mes)!.push(v);
  });
  const historico_mensal: HistoricoMensal[] = [...byMonth.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([mes, vals]) => ({ mes, iv_media: round1(mean(vals)), iv_max: round1(Math.max(...vals)) }));

  const result: IVRankResult = {
    ticker: tk,
    periodo_dias: periodo,
    data_referencia: serieDates[serieDates.length - 1] || dates[dates.length - 1],
    iv_atual: ivAtual,
    iv_fonte: ivFonte,
    iv_min_periodo: round1(Math.min(...serie)),
    iv_max_periodo: round1(Math.max(...serie)),
    iv_media_periodo: ivMedia,
    iv_rank: round1(ivRank),
    iv_percentile: round1(ivPercentile),
    classificacao: nivel,
    sinal_operacional: sinal,
    historico_insuficiente,
    dias_disponiveis: diasDisponiveis,
    ...(aviso ? { aviso } : {}),
    multi_periodo,
    consenso,
    consenso_sinal,
    consenso_confianca,
    alerta_evento,
    ...(alerta_evento_msg ? { alerta_evento_msg } : {}),
    cache_hit: false,
    historico_mensal,
  };

  ivCache.set(cacheKey, { data: result, timestamp: Date.now() });
  return result;
}

export interface IVRankBulkResult {
  periodo_dias: number;
  data_referencia: string;
  total_ativos: number;
  cache_hits: number;
  api_calls: number;
  tempo_execucao_ms: number;
  resumo: { muito_alta: number; alta: number; media: number; baixa: number };
  ranking: Array<{
    posicao: number;
    ticker: string;
    iv_rank: number;
    iv_atual: number;
    classificacao: string;
    sinal_operacional: string;
    cache_hit: boolean;
  }>;
  triagem: {
    prontos_para_operar: Array<{
      ticker: string;
      iv_rank_63d: number;
      consenso: string;
      consenso_confianca: string;
      alerta_evento: boolean;
    }>;
    verificar_antes: Array<{ ticker: string; motivo: string }>;
    descartar: Array<{ ticker: string; motivo: string }>;
  };
  erros?: Array<{ ticker: string; erro: string }>;
}

/**
 * Calcula IV Rank de múltiplos tickers, ranqueando por iv_rank decrescente.
 * Tickers em cache não consomem chamadas à API; os demais são processados em
 * lotes de 3 com 300ms entre lotes (evita HTTP 429).
 */
export async function getIVRankBulk(
  client: AxiosInstance,
  tickers: string[] | undefined,
  periodo: number
): Promise<IVRankBulkResult> {
  const start = Date.now();
  const list = (tickers && tickers.length ? tickers : WHITELIST_24).map((t) => String(t).toUpperCase());

  const results: IVRankResult[] = [];
  const errors: Array<{ ticker: string; erro: string }> = [];
  const toFetch: string[] = [];
  let cacheHits = 0;

  // 1) cache primeiro — não consome API
  for (const tk of list) {
    const cached = ivCache.get(`${tk}_${periodo}`);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      results.push({ ...cached.data, cache_hit: true });
      cacheHits++;
    } else {
      toFetch.push(tk);
    }
  }

  // 2) lotes de 3 com delay de 300ms
  const fetched = await batchWithLimit(
    toFetch,
    async (tk) => {
      try {
        return await getIVRankHistorico(client, tk, periodo);
      } catch (e) {
        errors.push({ ticker: tk, erro: e instanceof Error ? e.message : String(e) });
        return null;
      }
    },
    3,
    300
  );
  for (const r of fetched) if (r) results.push(r);

  // 3) ordenar por iv_rank decrescente
  results.sort((a, b) => b.iv_rank - a.iv_rank);

  const resumo = { muito_alta: 0, alta: 0, media: 0, baixa: 0 };
  for (const r of results) {
    if (r.classificacao === "MUITO_ALTA") resumo.muito_alta++;
    else if (r.classificacao === "ALTA") resumo.alta++;
    else if (r.classificacao === "MEDIA") resumo.media++;
    else resumo.baixa++;
  }

  const ranking = results.map((r, i) => ({
    posicao: i + 1,
    ticker: r.ticker,
    iv_rank: r.iv_rank,
    iv_atual: r.iv_atual,
    classificacao: r.classificacao,
    sinal_operacional: r.sinal_operacional,
    cache_hit: r.cache_hit,
  }));

  // Ajuste 4 — triagem automática por consenso/alertas.
  const triagem: IVRankBulkResult["triagem"] = {
    prontos_para_operar: [],
    verificar_antes: [],
    descartar: [],
  };
  for (const r of results) {
    if (r.historico_insuficiente) {
      triagem.descartar.push({ ticker: r.ticker, motivo: `INSUFICIENTE — apenas ${r.dias_disponiveis} dias úteis` });
    } else if (r.consenso_confianca === "BAIXA" || r.alerta_evento) {
      const motivo = r.alerta_evento
        ? "ALERTA_EVENTO — IV 2x acima da média"
        : `DIVERGENTE — 252d=${round1(r.multi_periodo.iv_rank_252d)}% vs 63d=${round1(r.multi_periodo.iv_rank_63d)}%`;
      triagem.verificar_antes.push({ ticker: r.ticker, motivo });
    } else if (r.consenso_confianca === "ALTA" && (r.consenso === "MUITO_ALTA" || r.consenso === "ALTA")) {
      triagem.prontos_para_operar.push({
        ticker: r.ticker,
        iv_rank_63d: r.multi_periodo.iv_rank_63d,
        consenso: r.consenso,
        consenso_confianca: r.consenso_confianca,
        alerta_evento: r.alerta_evento,
      });
    }
  }

  return {
    periodo_dias: periodo,
    data_referencia: results[0]?.data_referencia ?? new Date().toISOString().slice(0, 10),
    total_ativos: list.length,
    cache_hits: cacheHits,
    api_calls: toFetch.length,
    tempo_execucao_ms: Date.now() - start,
    resumo,
    ranking,
    triagem,
    ...(errors.length ? { erros: errors } : {}),
  };
}
