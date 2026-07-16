// ─────────────────────────────────────────────────────────────────────────────
// whitelist_source.ts — fonte da whitelist padrão (fallback quando `tickers` não é
// informado). Núcleo PURO (sem axios/SDK): testável isoladamente.
//
// FONTE DE VERDADE: a aba DADOS_ATIVOS da planilha "Controle de Opções", mantida
// pelo operador. Para eliminar a deriva (lista do código x planilha), o servidor
// pode ler essa aba dinamicamente via um endpoint CSV "Publicar na web" do Google
// Sheets, informado na env DADOS_ATIVOS_CSV_URL. Se a env não estiver configurada
// ou a leitura falhar, cai no WHITELIST_FALLBACK abaixo — que é uma CÓPIA MANUAL da
// aba e precisa ser resincronizada à mão sempre que a planilha mudar.
//
// Snapshot de DADOS_ATIVOS em 15/07/2026 (26 ativos).
// ─────────────────────────────────────────────────────────────────────────────

export const WHITELIST_FALLBACK: string[] = [
  "B3SA3", "BBAS3", "BBDC4", "BRAV3", "BRKM5", "CMIG4", "CSAN3", "CSNA3",
  "DIRR3", "EMBJ3", "EQTL3", "FLRY3", "GGBR4", "ITSA4", "ITUB4", "NATU3",
  "PETR4", "PRIO3", "PSSA3", "SANB11", "USIM5", "VALE3", "EGIE3", "WEGE3",
  "BPAC11", "SUZB3",
]; // 26 ativos — cópia manual da aba DADOS_ATIVOS (resincronizar se a planilha mudar)

// Um ticker B3 é 4 letras + 1–2 dígitos (ex.: VALE3, SANB11, BPAC11).
const TICKER_RE = /^[A-Z]{4}\d{1,2}$/;

/**
 * Extrai a lista de tickers de um CSV (Google Sheets "Publicar na web").
 * PURO e tolerante: acha a coluna cujo cabeçalho é TICKER (case-insensitive);
 * se não houver cabeçalho reconhecível, usa a 1ª coluna. Ignora aspas, espaços e
 * linhas vazias; mantém só o que parece ticker B3; deduplica preservando a ordem.
 */
export function parseTickersCSV(text: string): string[] {
  const linhas = String(text).split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (linhas.length === 0) return [];

  const celulas = (linha: string): string[] =>
    linha.split(",").map((c) => c.replace(/^"(.*)"$/, "$1").trim().toUpperCase());

  // Descobre o índice da coluna TICKER pelo cabeçalho; senão, coluna 0.
  const header = celulas(linhas[0]);
  let col = header.findIndex((h) => h === "TICKER" || h === "TICKERS" || h === "ATIVO" || h === "CODIGO");
  let dataStart = 0;
  if (col >= 0) dataStart = 1; // primeira linha é cabeçalho
  else col = 0;               // sem cabeçalho reconhecível — assume 1ª coluna, começa da linha 0

  const vistos = new Set<string>();
  const out: string[] = [];
  for (let i = dataStart; i < linhas.length; i++) {
    const cel = celulas(linhas[i]);
    const tk = (cel[col] ?? "").replace(/[^A-Z0-9]/g, "");
    if (TICKER_RE.test(tk) && !vistos.has(tk)) { vistos.add(tk); out.push(tk); }
  }
  return out;
}

/**
 * Busca a whitelist no endpoint CSV e valida. LANÇA em caso de falha (rede, HTTP,
 * conteúdo insuficiente) — o chamador decide cair no fallback. `fetchImpl` é
 * injetável para teste.
 */
export async function fetchWhitelistCSV(
  url: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 8000,
): Promise<string[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let text: string;
  try {
    const resp = await fetchImpl(url, { signal: ctrl.signal });
    if (!(resp as Response).ok) throw new Error(`HTTP ${(resp as Response).status}`);
    text = await (resp as Response).text();
  } finally {
    clearTimeout(timer);
  }
  const tickers = parseTickersCSV(text);
  // Guarda contra publicação quebrada/vazia: exige um mínimo plausível.
  if (tickers.length < 5) throw new Error(`CSV retornou apenas ${tickers.length} tickers válidos (esperado ≥5) — mantendo fallback`);
  return tickers;
}
