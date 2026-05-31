# CHANGELOG — Histórico de Desenvolvimento

Registro do que foi desenvolvido no **OpLab MCP Server**, em ordem cronológica.
Cada bloco corresponde a um Pull Request mergeado na `main` e implantado em produção
(Cloud Run, região `us-east1`).

Formato das versões: a contagem de ferramentas (`tools`) reportada por `GET /health`.

---

## Base — 29 ferramentas de Market

Servidor MCP em TypeScript/Express sobre SSE, expondo as 29 ferramentas da seção
**Market** da API REST da OpLab v3 (taxas, opções, cotação, instrumentos, companhias,
ações, estatísticas, rankings, histórico, bolsas). Arquitetura de baixo nível com
`Server` do SDK + `SSEServerTransport`, lista de ferramentas estática derivada do
`TOOL_REGISTRY`. Ver [README.md](README.md) → "Os Bugs Críticos" para o histórico de
estabilização do transporte SSE no Cloud Run.

---

## PR #15 — IV Rank (ferramentas 30 e 31) · `tools: 29 → 31`

Primeiras ferramentas **compostas**, com lógica isolada em `src/utils/iv_calculator.ts`.

- **`get_iv_rank_historico`** — IV Rank + IV Percentile de um ativo a partir da
  volatilidade realizada de 21 dias (anualizada), classificação operacional e histórico
  mensal. Fonte da IV atual: `iv_current` de `/market/stocks` (fallback para vol.
  realizada).
- **`get_iv_rank_bulk`** — IV Rank de vários ativos (whitelist de 24), ranqueados por
  IV Rank decrescente.
- **Infra do módulo:** funções matemáticas puras (`calcRetornosLog`,
  `calcVolatilidade21d`, `calcIVRank`, `calcIVPercentile`, `classificarIVRank`),
  **cache em memória de 4h** e **`batchWithLimit`** (lotes de 3 com 300ms → evita HTTP 429).
- **Padrão `handler`:** o `ToolDef` ganhou o campo opcional `handler`; o `CallTool`
  despacha para ele quando presente, senão segue o fluxo `build` + GET. As 29 ferramentas
  existentes não foram alteradas.

---

## PR #16 — Deploy em um comando + documentação

- **`deploy.sh`** — cria o repositório do Artifact Registry se faltar, faz build + push,
  deploy no Cloud Run com todos os parâmetros obrigatórios e roda o health check. Roda
  com `./deploy.sh` (variáveis: `PROJECT_ID`, `REGION`, `REPO`, `SERVICE`).
- **`cloudbuild.yaml`** — pipeline build + push + deploy num único comando
  (`gcloud builds submit --config cloudbuild.yaml .`) ou via trigger.
- **`.dockerignore`** limpo + docs (`README`/`INDEX`/`CLAUDE`) atualizados com o fluxo
  de deploy e o padrão `build` vs `handler`.

---

## PR #17 — IV Rank: qualidade de sinal · (refino das ferramentas 30/31)

Quatro ajustes em `src/utils/iv_calculator.ts` (sem novas ferramentas):

1. **Histórico insuficiente** — ativos com `< 126` dias úteis recebem
   `classificacao: "INSUFICIENTE"` e aviso; entre 126 e o período pedido, calcula com
   dados parciais e avisa. Campos: `historico_insuficiente`, `dias_disponiveis`, `aviso`.
2. **Multi-período e consenso** — IV Rank nas 4 janelas (21/63/126/252d) sem chamadas
   extras; consenso cruzando 63d×126d (`consenso`, `consenso_sinal`, `consenso_confianca`;
   `DIVERGENTE` quando discordam). O `classificacao`/`sinal_operacional` originais
   continuam baseados no período solicitado.
3. **Detecção de evento corporativo** — `iv_atual > 2× média` marca `alerta_evento` e
   troca o sinal por `⚠️ VERIFICAR EVENTO`.
4. **Triagem no bulk** — campo `triagem` com `prontos_para_operar` / `verificar_antes` /
   `descartar`.

---

## PR #18 — Backtesting do Protocolo 2 (ferramenta 32) · `tools: 31 → 32`

- **`get_backtest_protocolo2`** — ferramenta **analítica** (apenas simula) que faz
  backtesting histórico da venda de PUTs OTM. Lógica isolada em
  `src/utils/backtest_engine.ts`.
- **Por ativo/dia:** filtros (IV Rank, M9/M21) → seleção da PUT (delta/DTE/prêmio) →
  simulação no vencimento (WIN/LOSS, P/L, margem 22%) → anti-sobreposição.
- **Sempre calcula `comparativo_filtros`** (com/sem cada filtro) como prova estatística.
- **Infra:** cache de 24h, lotes de 3 com 500ms, timeout de 10s/ativo, período máx. de
  2 anos, retry de até 3 dias anteriores quando a cadeia não tem dados na data.
- **Fonte de dados:** `/market/historical/options` (tem delta/premium/DTE reais). Volume
  de PUT não existe no histórico → operações marcadas com `volume_nao_verificado`.

---

## PR #19 — Trava Bull Put Spread no backtest · (refino da ferramenta 32)

Após o backtest de 2 anos mostrar que **PUT a descoberto não fecha positivo** (win rate
~53%, P&L negativo pela assimetria ganho/perda), adicionou-se a simulação **com proteção**:

- **`use_spread`** (default `false`) e **`spread_width`** (default 3.0).
- **`selectProtective()`** — escolhe a PUT comprada do mesmo vencimento com strike ≈
  `vendido − spread_width`, usando o prêmio real da cadeia.
- **`simulate()`** — com proteção, calcula o payoff da trava: ganho máx = crédito líquido;
  **perda máx = `(largura − crédito) × 100`** (limitada). Default (naked) inalterado.
- Validado contra cadeia real (a trava reduziu uma perda de −R$5.738 para −R$1.292).

---

## PR #20 — Plano mensal de travas (ferramenta 33) · `tools: 32 → 33`

- **`get_oportunidades_mensais`** — ferramenta **analítica** (apenas sugere) que monta um
  plano mensal de travas Bull Put Spread para atingir a meta de prêmio do mês dentro do
  capital/margem. Lógica isolada em `src/utils/opportunity_engine.ts`.
- **Filtros de qualidade:** IV Rank ≥ 50, M9/M21 ≥ 1.0, volume PUT ≥ R$5M (lotes de 3, 300ms).
- **Seleção da trava** na cadeia ao vivo via `get_instrument_series?bs=true` (delta em
  `put.bs.delta`, `bid`/`ask` reais): vende a PUT de maior bid no range; compra a proteção
  ≈ `vendido − spread_width`. Prêmio líquido = `bid_venda − ask_compra`.
- **Dimensionamento de lotes** para a meta dentro da margem, concentração máx. 35%/ativo.
- **Regras de negócio:** nunca `M9/M21 < 1.0`, nunca `delta < -0.30`, descarta prêmio
  líquido `< R$0,40`. Plano vazio com explicação quando nada passa.

---

## Estado atual

| Item | Valor |
|---|---|
| Ferramentas | **33** (29 `build` + 4 `handler`) |
| Health check | `{"status":"ok","tools":33,"api":"reachable"}` |
| Região | `us-east1` (Cloud Run) |
| Módulos de lógica | `iv_calculator.ts`, `backtest_engine.ts`, `opportunity_engine.ts` |
| Deploy | `./deploy.sh` ou `cloudbuild.yaml` |

Catálogo completo das ferramentas: [FERRAMENTAS.md](FERRAMENTAS.md).

> **Nota sobre cache do cliente:** o Claude Web/Mobile faz cache da lista de ferramentas.
> Após um deploy que adiciona ferramentas, pode ser necessário **reconectar o conector**
> (desconectar/reconectar) para que as novas apareçam — o servidor já as expõe
> corretamente no `ListTools` (verificável conectando um cliente MCP ao endpoint `/sse`).
