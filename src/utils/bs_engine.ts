// ─────────────────────────────────────────────────────────────────────────────
// bs_engine.ts — Black-Scholes LOCAL para get_options_bs.
//
// MOTIVO: a API OpLab /market/options/bs IGNORA os parâmetros spotprice/vol/dtm
// quando recebe o symbol de uma opção (usa dados internos/stale) e dá erro 500 no
// modo ação. Isso quebra o "what-if" (precificar dado um spot/vol hipotético).
// Quando o chamador fornece os inputs de um BS auto-contido, calculamos aqui —
// fórmula fechada, mesma que foi validada contra o exemplo do Hull em
// scripts/bs_oracle.py (call 4,76 / put 0,81 / N(d1) 0,7791) e na paridade put-call.
//
// Modelo: Black-Scholes europeu, sem dividendos. Para CALL sobre ação sem proventos,
// equivale ao americano. Convenções das gregas alinhadas ao endpoint: vega e rho por
// 1 ponto de vol/juros (÷100), theta por dia corrido (÷365). Determinístico.
// ─────────────────────────────────────────────────────────────────────────────

function normCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}
// erf via aproximação de Abramowitz & Stegun 7.1.26 (|erro| < 1.5e-7).
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return sign * y;
}
function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

export interface BSInput { S: number; K: number; r: number; T: number; sigma: number; tipo: "CALL" | "PUT"; }
export interface BSResult {
  price: number; delta: number; gamma: number; vega: number; theta: number; rho: number;
  d1: number; d2: number;
}

/** Preço e gregas por fórmula fechada. r/sigma em FRAÇÃO (0.10 = 10%), T em ANOS. */
export function blackScholes({ S, K, r, T, sigma, tipo }: BSInput): BSResult {
  if (!(T > 0) || !(sigma > 0)) {
    // limite: valor intrínseco, gregas degeneradas
    const intr = Math.max(0, tipo === "CALL" ? S - K : K - S);
    return { price: intr, delta: NaN, gamma: 0, vega: 0, theta: 0, rho: 0, d1: NaN, d2: NaN };
  }
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const discR = Math.exp(-r * T);
  const Nd1 = normCdf(d1), Nd2 = normCdf(d2);
  const pdf = normPdf(d1);

  let price: number, delta: number, rho: number;
  if (tipo === "CALL") {
    price = S * Nd1 - K * discR * Nd2;
    delta = Nd1;
    rho = (K * T * discR * Nd2) / 100;
  } else {
    price = K * discR * normCdf(-d2) - S * normCdf(-d1);
    delta = Nd1 - 1;
    rho = (-K * T * discR * normCdf(-d2)) / 100;
  }
  const gamma = pdf / (S * sigma * sqrtT);
  const vega = (S * pdf * sqrtT) / 100; // por 1 ponto de vol
  const thetaAno = -(S * pdf * sigma) / (2 * sqrtT)
    - (tipo === "CALL" ? r * K * discR * Nd2 : -r * K * discR * normCdf(-d2));
  const theta = thetaAno / 365; // por dia corrido
  return { price, delta, gamma, vega, theta, rho, d1, d2 };
}

const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : NaN);

/** Sigma/juros aceitam % (23.4) ou fração (0.234): valor ≥1 é tratado como %. */
export function normalizarFracao(v: number): number { return v >= 1 ? v / 100 : v; }

/**
 * Decide se dá para calcular o BS localmente (todos os inputs auto-contidos) e,
 * em caso afirmativo, devolve o payload MCP. Senão retorna null (chamador faz o
 * passthrough para o endpoint). `agora` injetável para determinismo em teste.
 */
export function precificarLocalSePossivel(a: Record<string, unknown>, agora: number = Date.now()): Record<string, unknown> | null {
  const S = num(a.spotprice);
  const K = num(a.strike);
  const volRaw = num(a.vol);
  const irate = num(a.irate);
  const tipo = String(a.type ?? "").toUpperCase();
  if (tipo !== "CALL" && tipo !== "PUT") return null;
  if (!Number.isFinite(S) || !Number.isFinite(K) || !Number.isFinite(volRaw) || !Number.isFinite(irate)) return null;

  // T a partir de dtm (dias corridos) ou duedate.
  let dias = num(a.dtm);
  if (!Number.isFinite(dias)) {
    const dd = String(a.duedate ?? "").trim();
    const m = dd.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) dias = Math.round((Date.UTC(+m[1], +m[2] - 1, +m[3]) - agora) / 86_400_000);
  }
  if (!Number.isFinite(dias) || dias <= 0) return null; // sem prazo válido → passthrough

  const sigma = normalizarFracao(volRaw);
  const r = normalizarFracao(irate);
  const T = dias / 365;
  const bs = blackScholes({ S, K, r, T, sigma, tipo: tipo as "CALL" | "PUT" });
  const r4 = (n: number) => Math.round(n * 10000) / 10000;

  return {
    price: r4(bs.price),
    delta: r4(bs.delta),
    gamma: bs.gamma,
    vega: bs.vega,
    theta: bs.theta,
    rho: bs.rho,
    volatility: r4(sigma * 100),
    spotprice: S,
    strike: K,
    dtm: dias,
    moneyness: Math.abs(S - K) / K <= 0.01 ? "ATM" : (S > K ? (tipo === "CALL" ? "ITM" : "OTM") : (tipo === "CALL" ? "OTM" : "ITM")),
    metodo: "black_scholes_local_europeu",
    aviso: "Calculado LOCALMENTE a partir dos parâmetros informados. O endpoint OpLab /market/options/bs ignora spotprice/vol quando recebe o symbol de uma opção (e erra 500 no modo ação); por isso o what-if é calculado aqui. Modelo europeu sem dividendos.",
  };
}
