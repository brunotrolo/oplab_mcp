// ---------------------------------------------------------------------------
// Opportunity engine — montador de plano mensal de travas Bull Put Spread.
//
// Arquivo SEPARADO de src/index.ts (ferramenta 33). O index.ts só registra a
// entrada com `handler`. ⚠️ ANALÍTICA — apenas sugere um plano; não envia ordens.
//
// Combina filtros de qualidade (IV Rank, tendência M9/M21, volume de PUT) com a
// seleção de travas reais da cadeia ao vivo, dimensionando lotes para atingir a
// meta de prêmio do mês dentro da margem disponível.
//
// Fontes de dados OpLab (todas com prêmio/greeks/bid-ask REAIS, sem modelagem):
//   • GET /market/stocks/{ticker}                  → spot, m9_m21.value, iv_current
//   • GET /market/statistics/realtime/highest_options_volume?order_by=put
//                                                   → volume financeiro de PUT por ativo
//   • GET /market/instruments/series/{ticker}?bs=true&irate=R
//        cada put tem: bid, ask, strike, category, bs.delta; série tem due_date/dtm
//   IV Rank: reutiliza getIVRankHistorico (cache 4h) de iv_calculator.
// ---------------------------------------------------------------------------

import { AxiosInstance } from "axios";
import { batchWithLimit, getIVRankHistorico, normalizarPeriodo } from "./iv_calculator.js";

// ── Constantes / defaults ─────────────────────────────────────────────────────

const CONTRACT_SIZE = 100;
const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_IRATE = 14.9; // taxa p/ Black-Scholes da série (SELIC aproximada)

const IV_RANK_MIN = 50;                 // filtro A
const VOLUME_PUT_MIN = 5_000_000;       // filtro C (R$)
const DELTA_FLOOR = -0.30;              // regra: nunca delta < -0.30
const PREMIO_LIQUIDO_MIN = 0.40;        // regra: prêmio mínimo R$/ação
const MAX_CONCENTRACAO = 0.35;          // regra: máx 35% da margem do plano por ativo

// Lista padrão de 12 ativos pré-selecionados por prêmio histórico adequado.
export const WHITELIST_OPORTUNIDADES = [
  "EMBJ3", "VALE3", "PRIO3", "SANB11", "PETR4", "ITUB4",
  "BBAS3", "BBDC4", "PSSA3", "B3SA3", "USIM5", "GGBR4",
];

// ── Helpers ───────────────────────────────────────────────────────────────────

const round2 = (n: number): number => Math.round(n * 100) / 100;
const round1 = (n: number): number => Math.round(n * 10) / 10;

function num(v: unknown, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

/** Formata "YYYY-MM-DD" → "DD/MM/YYYY". */
function fmtBR(d: string): string {
  const s = d.slice(0, 10).split("-");
  return s.length === 3 ? `${s[2]}/${s[1]}/${s[0]}` : d;
}

// ── Tipos ────────────────────────────────────────────────────────────────────

export interface OportunidadeParams {
  capital: number;
  meta_mensal: number;
  margem_max_pct: number;
  spread_width: number;
  delta_min: number;
  delta_max: number;
  dte_min: number;
  dte_max: number;
  iv_rank_periodo: number;
  tickers: string[];
}

interface PutOption {
  symbol: string;
  strike: number;
  delta: number;
  bid: number;
  ask: number;
  dte: number;
  due_date: string;
}

interface AtivoAprovado {
  ticker: string;
  spot: number;
  iv_rank: number;
  m9m21: number;
  volume_put_mm: number;
  venda: PutOption;
  compra: PutOption;
  premio_liquido: number;
}

export interface OportunidadeResult {
  data_analise: string;
  parametros: {
    capital: number;
    meta_mensal: number;
    margem_max_pct: number;
    spread_width: number;
    delta_min: number;
    delta_max: number;
    iv_rank_periodo: number;
  };
  viabilidade: {
    meta_atingivel: boolean;
    premium_projetado: number;
    premio_vs_meta_pct: number;
    margem_total: number;
    pct_capital_usado: number;
    margem_disponivel_restante: number;
    ativos_aprovados: number;
    ativos_eliminados: number;
    motivos_eliminacao: {
      iv_rank_baixo: number;
      m9m21_baixo: number;
      volume_insuficiente: number;
      sem_trava_viavel: number;
    };
  };
  plano_execucao: Array<Record<string, unknown>>;
  resumo_financeiro: {
    premio_total_projetado: number;
    margem_total_consumida: number;
    pct_capital_em_margem: number;
    margem_restante_disponivel: number;
    retorno_sobre_capital_pct: number;
    retorno_anualizado_pct: number;
  };
  alertas: string[];
  proxima_janela: string;
}

// ── Parsing da série de opções (bs=true) ──────────────────────────────────────

/**
 * Extrai PUTs com bid/ask/delta da resposta de /market/instruments/series?bs=true.
 * Cada put tem greeks em `put.bs.delta`, bid/ask no topo e strike; a série traz
 * due_date e days_to_maturity.
 */
function extractPuts(raw: unknown): PutOption[] {
  const obj = raw as Record<string, unknown> | undefined;
  const series = obj && Array.isArray(obj.series) ? (obj.series as unknown[]) : Array.isArray(raw) ? raw : [];
  const puts: PutOption[] = [];
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
      const bid = Number(p.bid);
      const ask = Number(p.ask);
      if (!isFinite(delta) || !isFinite(strike)) continue;
      puts.push({
        symbol: String(p.symbol ?? ""),
        strike,
        delta,
        bid: isFinite(bid) ? bid : 0,
        ask: isFinite(ask) ? ask : 0,
        dte: isFinite(dte) ? dte : Number(p.days_to_maturity),
        due_date: due || (typeof p.due_date === "string" ? p.due_date.slice(0, 10) : ""),
      });
    }
  }
  return puts;
}

/** Volume financeiro de PUT por ativo (mapa ticker → R$). */
function parseVolumePut(raw: unknown): Map<string, number> {
  const rows = Array.isArray(raw) ? raw : [];
  const m = new Map<string, number>();
  for (const r of rows) {
    const o = r as Record<string, unknown>;
    const sym = String(o.symbol ?? "").toUpperCase();
    const put = Number(o.put);
    if (sym && isFinite(put)) m.set(sym, put);
  }
  return m;
}

// ── Seleção da trava ──────────────────────────────────────────────────────────

/**
 * Seleciona a perna vendida (maior bid dentro do range de delta/DTE) e a perna
 * comprada de proteção (strike ≈ vendida - spread_width, mesmo vencimento).
 * Retorna null se não houver trava viável (sem candidata, sem proteção, ou
 * prêmio líquido insuficiente).
 */
function selecionarTrava(puts: PutOption[], p: OportunidadeParams): { venda: PutOption; compra: PutOption; premioLiquido: number } | null {
  // Regra: nunca delta abaixo do piso (-0.30); respeita o range pedido.
  const deltaMin = Math.max(p.delta_min, DELTA_FLOOR);
  const candidatas = puts.filter(
    (o) =>
      o.dte >= p.dte_min &&
      o.dte <= p.dte_max &&
      o.delta >= deltaMin &&
      o.delta <= p.delta_max &&
      o.bid > 0 // liquidez real (bid)
  );
  if (candidatas.length === 0) return null;

  // Vendida: maior bid (Max Gain) dentro do range.
  candidatas.sort((a, b) => b.bid - a.bid);
  const venda = candidatas[0];

  // Proteção: mesma data, strike mais próximo de (strike_vendido - spread_width), abaixo.
  const alvo = venda.strike - p.spread_width;
  const protecoes = puts.filter((o) => o.due_date === venda.due_date && o.strike < venda.strike && o.strike > 0);
  if (protecoes.length === 0) return null;
  protecoes.sort((a, b) => Math.abs(a.strike - alvo) - Math.abs(b.strike - alvo));
  const compra = protecoes[0];

  // Prêmio líquido = bid_vendida - ask_comprada (ask pode ser 0/ausente → usa bid como piso).
  const askCompra = compra.ask > 0 ? compra.ask : compra.bid;
  const premioLiquido = round2(venda.bid - askCompra);
  if (premioLiquido < PREMIO_LIQUIDO_MIN) return null;

  return { venda, compra, premioLiquido };
}

// ── Avaliação de um ativo (filtros + trava) ───────────────────────────────────

type Rejeicao = "iv_rank_baixo" | "m9m21_baixo" | "volume_insuficiente" | "sem_trava_viavel";

interface AvaliacaoTicker {
  ticker: string;
  aprovado?: AtivoAprovado;
  rejeicao?: Rejeicao;
  detalhe?: string;
}

async function avaliarTicker(
  client: AxiosInstance,
  ticker: string,
  volumePut: Map<string, number>,
  p: OportunidadeParams
): Promise<AvaliacaoTicker> {
  const tk = ticker.toUpperCase();

  // Filtros A (IV Rank) e B (M9/M21): get_stock traz m9_m21 + iv_current; IV Rank via cache.
  let spot = 0;
  let m9m21 = NaN;
  try {
    const { data } = await client.get(`/market/stocks/${tk}`, { timeout: REQUEST_TIMEOUT_MS });
    const o = data as Record<string, unknown>;
    spot = Number(o.close ?? o.bid ?? o.spot_price);
    const mm = o.m9_m21 as Record<string, unknown> | undefined;
    m9m21 = Number(mm?.value);
  } catch {
    return { ticker: tk, rejeicao: "volume_insuficiente", detalhe: "sem dados do ativo" };
  }

  // Regra crítica: NUNCA recomendar M9/M21 < 1.0.
  if (!(m9m21 >= 1.0)) {
    return { ticker: tk, rejeicao: "m9m21_baixo", detalhe: `M9M21=${isFinite(m9m21) ? round2(m9m21) : "n/d"} (baixista)` };
  }

  // Filtro C: volume financeiro de PUT >= 5MM.
  const vol = volumePut.get(tk) ?? 0;
  if (vol < VOLUME_PUT_MIN) {
    return { ticker: tk, rejeicao: "volume_insuficiente", detalhe: `volume PUT R$${round1(vol / 1e6)}MM < 5MM` };
  }

  // Filtro A: IV Rank >= 50 na janela escolhida (iv_rank_periodo). 63d reage mais
  // rápido ao regime atual; 252d compara com a faixa anual inteira — em mercados
  // que saíram de um pico recente de volatilidade, 252d costuma dar rank mais alto.
  let ivRank = NaN;
  try {
    const r = await getIVRankHistorico(client, tk, p.iv_rank_periodo);
    ivRank = r.iv_rank;
  } catch {
    ivRank = NaN;
  }
  if (!(ivRank >= IV_RANK_MIN)) {
    return { ticker: tk, rejeicao: "iv_rank_baixo", detalhe: `IV Rank ${p.iv_rank_periodo}d=${isFinite(ivRank) ? round1(ivRank) : "n/d"}% < ${IV_RANK_MIN}%` };
  }

  // Trava real da cadeia ao vivo (série com bs=true).
  let puts: PutOption[];
  try {
    const { data } = await client.get(`/market/instruments/series/${tk}`, {
      params: { bs: true, irate: DEFAULT_IRATE },
      timeout: REQUEST_TIMEOUT_MS,
    });
    puts = extractPuts(data);
  } catch {
    return { ticker: tk, rejeicao: "sem_trava_viavel", detalhe: "sem cadeia de opções" };
  }
  const trava = selecionarTrava(puts, p);
  if (!trava) {
    return { ticker: tk, rejeicao: "sem_trava_viavel", detalhe: "sem trava com prêmio/liquidez suficiente" };
  }

  return {
    ticker: tk,
    aprovado: {
      ticker: tk,
      spot: round2(spot),
      iv_rank: round1(ivRank),
      m9m21: round2(m9m21),
      volume_put_mm: round1(vol / 1e6),
      venda: trava.venda,
      compra: trava.compra,
      premio_liquido: trava.premioLiquido,
    },
  };
}

// ── Dimensionamento de lotes ──────────────────────────────────────────────────

interface TravaPlano {
  ativo: AtivoAprovado;
  lotes: number;
  premioTotal: number;
  margemTrava: number;
}

/**
 * Distribui lotes entre os ativos aprovados visando a meta, sem ultrapassar a
 * margem total nem a concentração máxima por posição (35%).
 */
function dimensionar(aprovados: AtivoAprovado[], p: OportunidadeParams): { travas: TravaPlano[]; alertas: string[] } {
  const alertas: string[] = [];
  const margemDisponivel = p.capital * p.margem_max_pct;
  const margemPorLote = p.spread_width * CONTRACT_SIZE; // largura nominal da trava
  const n = aprovados.length;
  const metaPorAtivo = p.meta_mensal / n;
  const margemMaxPorAtivo = margemDisponivel * MAX_CONCENTRACAO;

  const travas: TravaPlano[] = aprovados.map((ativo) => {
    const premioAcaoLote = ativo.premio_liquido * CONTRACT_SIZE; // R$ por lote
    let lotes = Math.max(1, Math.ceil(metaPorAtivo / premioAcaoLote));
    // Limita pela margem do ativo (cota igualitária E teto de concentração de 35%).
    const tetoMargem = Math.min(margemDisponivel / n, margemMaxPorAtivo);
    const lotesMax = Math.max(1, Math.floor(tetoMargem / margemPorLote));
    if (lotes > lotesMax) lotes = lotesMax;
    return {
      ativo,
      lotes,
      premioTotal: round2(lotes * premioAcaoLote),
      margemTrava: round2(lotes * margemPorLote),
    };
  });

  // Se estourar a margem total, reduz proporcionalmente.
  let margemTotal = travas.reduce((s, t) => s + t.margemTrava, 0);
  if (margemTotal > margemDisponivel && margemTotal > 0) {
    const fator = margemDisponivel / margemTotal;
    for (const t of travas) {
      t.lotes = Math.max(0, Math.floor(t.lotes * fator));
      t.premioTotal = round2(t.lotes * t.ativo.premio_liquido * CONTRACT_SIZE);
      t.margemTrava = round2(t.lotes * margemPorLote);
    }
    alertas.push("ℹ️ Lotes reduzidos proporcionalmente para respeitar a margem máxima.");
  }

  return { travas: travas.filter((t) => t.lotes > 0), alertas };
}

// ── Normalização de parâmetros ────────────────────────────────────────────────

export function normalizarOportunidadeParams(a: Record<string, unknown>): OportunidadeParams {
  const tickers =
    Array.isArray(a.tickers) && a.tickers.length
      ? a.tickers.map((t) => String(t).toUpperCase())
      : [...WHITELIST_OPORTUNIDADES];
  return {
    capital: Math.max(0, num(a.capital, 0)),
    meta_mensal: Math.max(0, num(a.meta_mensal, 4000)),
    margem_max_pct: Math.min(1, Math.max(0.01, num(a.margem_max_pct, 0.35))),
    spread_width: Math.max(0.5, num(a.spread_width, 3.0)),
    delta_min: num(a.delta_min, -0.25),
    delta_max: num(a.delta_max, -0.15),
    dte_min: Math.round(num(a.dte_min, 15)),
    dte_max: Math.round(num(a.dte_max, 30)),
    // Período do IV Rank: 21, 63, 126 ou 252 (default 63). normalizarPeriodo cai
    // para 252 se vier valor inválido; aqui o default específico desta tool é 63.
    iv_rank_periodo: a.iv_rank_periodo === undefined ? 63 : normalizarPeriodo(a.iv_rank_periodo),
    tickers,
  };
}

// ── Orquestração ──────────────────────────────────────────────────────────────

export async function getOportunidadesMensais(client: AxiosInstance, args: Record<string, unknown>): Promise<OportunidadeResult> {
  const p = normalizarOportunidadeParams(args);
  const dataAnalise = new Date().toISOString().slice(0, 10);
  const alertas: string[] = [];

  const motivos = { iv_rank_baixo: 0, m9m21_baixo: 0, volume_insuficiente: 0, sem_trava_viavel: 0 };

  if (p.capital <= 0) {
    return montarVazio(p, dataAnalise, motivos, [
      "Capital inválido. Informe o capital total disponível (ex: capital=130000).",
    ]);
  }

  // Volume de PUT por ativo (1 chamada compartilhada). Limite alto para cobrir a whitelist.
  let volumePut = new Map<string, number>();
  try {
    const { data } = await client.get("/market/statistics/realtime/highest_options_volume", {
      params: { order_by: "put", limit: 100 },
      timeout: REQUEST_TIMEOUT_MS,
    });
    volumePut = parseVolumePut(data);
  } catch {
    alertas.push("⚠️ Não foi possível obter volumes de PUT — filtro de volume ignorado nesta rodada.");
    // sem volume: trata todos como aprovados no filtro C
    for (const tk of p.tickers) volumePut.set(tk, VOLUME_PUT_MIN);
  }

  // Filtros + seleção de trava em lotes de 3 com 300ms (anti rate-limit).
  const avaliacoes = await batchWithLimit(p.tickers, (tk) => avaliarTicker(client, tk, volumePut, p), 3, 300);

  const aprovados: AtivoAprovado[] = [];
  for (const av of avaliacoes) {
    if (av.aprovado) {
      aprovados.push(av.aprovado);
    } else if (av.rejeicao) {
      motivos[av.rejeicao]++;
      const icon = av.rejeicao === "sem_trava_viavel" ? "ℹ️" : "⚠️";
      alertas.push(`${icon} ${av.ticker} eliminado: ${av.detalhe ?? av.rejeicao}`);
    }
  }

  // Regra 5: nenhum ativo aprovado.
  if (aprovados.length === 0) {
    alertas.push(
      "Nenhum ativo aprovado hoje. Mercado não oferece oportunidade dentro dos critérios. Aguardar próxima janela."
    );
    return montarVazio(p, dataAnalise, motivos, alertas);
  }

  // Dimensiona lotes para a meta dentro da margem.
  const { travas, alertas: alertasDim } = dimensionar(aprovados, p);
  alertas.push(...alertasDim);

  if (travas.length === 0) {
    alertas.push("Margem insuficiente para montar ao menos uma trava. Aumente o capital ou a margem_max_pct.");
    return montarVazio(p, dataAnalise, motivos, alertas, aprovados.length);
  }

  // Monta o plano de execução.
  const plano = travas.map((t, i) => {
    const a = t.ativo;
    const retMargem = t.margemTrava > 0 ? round1((t.premioTotal / t.margemTrava) * 100) : 0;
    return {
      ordem: i + 1,
      ticker: a.ticker,
      spot: a.spot,
      iv_rank: a.iv_rank,
      m9m21: a.m9m21,
      volume_put_mm: a.volume_put_mm,
      venda: {
        option_ticker: a.venda.symbol,
        strike: round2(a.venda.strike),
        vencimento: fmtBR(a.venda.due_date),
        dte: a.venda.dte,
        delta: round2(a.venda.delta),
        bid: round2(a.venda.bid),
        ask: round2(a.venda.ask),
      },
      compra: {
        option_ticker: a.compra.symbol,
        strike: round2(a.compra.strike),
        vencimento: fmtBR(a.compra.due_date),
        dte: a.compra.dte,
        delta: round2(a.compra.delta),
        bid: round2(a.compra.bid),
        ask: round2(a.compra.ask),
      },
      trava: {
        premio_liquido: a.premio_liquido,
        spread_width: p.spread_width,
        lotes: t.lotes,
        premio_total: t.premioTotal,
        margem_trava: t.margemTrava,
        retorno_margem_pct: retMargem,
      },
      instrucao: `Vender ${a.venda.symbol} @ R$${a.venda.bid.toFixed(2)} | Comprar ${a.compra.symbol} @ R$${(a.compra.ask > 0 ? a.compra.ask : a.compra.bid).toFixed(2)} | ${t.lotes} lote(s)`,
    };
  });

  const premioTotal = round2(travas.reduce((s, t) => s + t.premioTotal, 0));
  const margemTotal = round2(travas.reduce((s, t) => s + t.margemTrava, 0));
  const margemDisponivel = p.capital * p.margem_max_pct;
  const pctCapital = round1((margemTotal / p.capital) * 100);
  const metaAtingivel = premioTotal >= p.meta_mensal;

  if (!metaAtingivel) {
    alertas.push(
      `Meta parcialmente atingida: R$${premioTotal} de R$${p.meta_mensal}. Aumentar spread_width ou reduzir a meta.`
    );
  } else {
    alertas.push(`ℹ️ Meta atingida com ${travas.length} ativo(s).`);
  }

  // DTE médio das vendas → retorno anualizado (252 dias úteis ≈ 365 corridos).
  const dteMedio = travas.reduce((s, t) => s + t.ativo.venda.dte, 0) / travas.length || 30;
  const retCapital = round2((premioTotal / p.capital) * 100);
  const retAnualizado = round1(retCapital * (365 / Math.max(1, dteMedio)));

  return {
    data_analise: dataAnalise,
    parametros: {
      capital: p.capital,
      meta_mensal: p.meta_mensal,
      margem_max_pct: p.margem_max_pct,
      spread_width: p.spread_width,
      delta_min: p.delta_min,
      delta_max: p.delta_max,
      iv_rank_periodo: p.iv_rank_periodo,
    },
    viabilidade: {
      meta_atingivel: metaAtingivel,
      premium_projetado: premioTotal,
      premio_vs_meta_pct: p.meta_mensal > 0 ? round2((premioTotal / p.meta_mensal) * 100) : 0,
      margem_total: margemTotal,
      pct_capital_usado: pctCapital,
      margem_disponivel_restante: round2(margemDisponivel - margemTotal),
      ativos_aprovados: aprovados.length,
      ativos_eliminados: p.tickers.length - aprovados.length,
      motivos_eliminacao: motivos,
    },
    plano_execucao: plano,
    resumo_financeiro: {
      premio_total_projetado: premioTotal,
      margem_total_consumida: margemTotal,
      pct_capital_em_margem: pctCapital,
      margem_restante_disponivel: round2(margemDisponivel - margemTotal),
      retorno_sobre_capital_pct: retCapital,
      retorno_anualizado_pct: retAnualizado,
    },
    alertas,
    proxima_janela: proximaJanela(),
  };
}

// ── Plano vazio (sem aprovados / capital inválido) ────────────────────────────

function montarVazio(
  p: OportunidadeParams,
  dataAnalise: string,
  motivos: OportunidadeResult["viabilidade"]["motivos_eliminacao"],
  alertas: string[],
  aprovados = 0
): OportunidadeResult {
  const margemDisponivel = p.capital * p.margem_max_pct;
  return {
    data_analise: dataAnalise,
    parametros: {
      capital: p.capital,
      meta_mensal: p.meta_mensal,
      margem_max_pct: p.margem_max_pct,
      spread_width: p.spread_width,
      delta_min: p.delta_min,
      delta_max: p.delta_max,
      iv_rank_periodo: p.iv_rank_periodo,
    },
    viabilidade: {
      meta_atingivel: false,
      premium_projetado: 0,
      premio_vs_meta_pct: 0,
      margem_total: 0,
      pct_capital_usado: 0,
      margem_disponivel_restante: round2(margemDisponivel),
      ativos_aprovados: aprovados,
      ativos_eliminados: p.tickers.length - aprovados,
      motivos_eliminacao: motivos,
    },
    plano_execucao: [],
    resumo_financeiro: {
      premio_total_projetado: 0,
      margem_total_consumida: 0,
      pct_capital_em_margem: 0,
      margem_restante_disponivel: round2(margemDisponivel),
      retorno_sobre_capital_pct: 0,
      retorno_anualizado_pct: 0,
    },
    alertas,
    proxima_janela: proximaJanela(),
  };
}

/** Próxima 3ª sexta-feira (janela de vencimento da B3) em texto. */
function proximaJanela(): string {
  const hoje = new Date();
  const tryMonth = (y: number, m: number): Date => {
    const first = new Date(Date.UTC(y, m, 1));
    const firstFriday = 1 + ((5 - first.getUTCDay() + 7) % 7);
    return new Date(Date.UTC(y, m, firstFriday + 14));
  };
  let y = hoje.getUTCFullYear();
  let m = hoje.getUTCMonth();
  let venc = tryMonth(y, m);
  if (venc.getTime() < hoje.getTime()) {
    m += 1;
    if (m > 11) { m = 0; y += 1; }
    venc = tryMonth(y, m);
  }
  const meses = ["JAN", "FEV", "MAR", "ABR", "MAI", "JUN", "JUL", "AGO", "SET", "OUT", "NOV", "DEZ"];
  return `${fmtBR(venc.toISOString())} (vencimento ${meses[venc.getUTCMonth()]}) — rodar novamente após`;
}
