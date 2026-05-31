# OpLab MCP Server

Servidor MCP (Model Context Protocol) construído em TypeScript/Node.js sobre Express, com transporte SSE (Server-Sent Events), hospedado no Google Cloud Run. Expõe **32 ferramentas**: 29 cobrindo toda a seção **Market** da API REST da OpLab v3, 2 ferramentas compostas de **IV Rank** (volatilidade implícita) e 1 de **backtesting** do Protocolo 2 — todas com cache e processamento em lote.

---

## Visão Geral da Arquitetura

```
Claude Web / Mobile
      │  GET /sse  (SSE stream)
      │  POST /messages  (JSON-RPC over HTTP)
      ▼
Cloud Run (us-east1)  ←  Secret Manager (OPLAB_ACCESS_TOKEN)
  Express + MCP SDK (SSEServerTransport)
      │  axios  GET /market/...
      ▼
api.oplab.com.br/v3
```

**Stack:**
- Runtime: Node.js 20
- Framework: Express 4
- MCP SDK: `@modelcontextprotocol/sdk` (low-level `Server` + `SSEServerTransport`)
- HTTP client: Axios
- Linguagem: TypeScript 5 / ES2022 / CommonJS
- CI/Build: Docker multi-stage (node:20-slim)
- Infra: Google Cloud Run + Artifact Registry + Secret Manager

---

## Estrutura de Arquivos

```
oplab_mcp/
├── src/
│   ├── index.ts                # Servidor + TOOL_REGISTRY (rotas, SSE, dispatch)
│   └── utils/
│       └── iv_calculator.ts    # Matemática de IV Rank + cache + lote (IV tools)
├── dist/                       # Saída do tsc (gerada)
├── Dockerfile                  # Multi-stage build (builder + runtime)
├── cloudbuild.yaml             # Pipeline build+push+deploy (Cloud Build/trigger)
├── deploy.sh                   # Deploy completo em um comando (credenciais locais)
├── .dockerignore
├── package.json
├── tsconfig.json
├── CLAUDE.md                   # Guia para assistentes de IA
├── INDEX.md                    # Mapa de calor do codebase
└── README.md                   # Este arquivo
```

### `src/index.ts` — estrutura interna

| Bloco | Responsabilidade |
|---|---|
| `createOplabClient()` | Cria instância Axios com `Access-Token` header |
| `interface PropDef / ToolDef` | Tipos do registro de ferramentas (campos `build` **ou** `handler`) |
| `TOOL_REGISTRY` | Array com 32 ferramentas (29 com `build`, 3 com `handler`) |
| `pick()` | Helper para filtrar parâmetros opcionais undefined |
| `TOOLS_LIST` | Lista estática derivada de `TOOL_REGISTRY` (retornada no `ListTools`) |
| `server` (singleton) | `Server` do SDK, handlers registrados uma vez |
| `CallTool` dispatch | Usa `entry.handler(client, args)` se presente; senão `entry.build()` + GET |
| Express routes | `/health`, `/sse`, `/messages` |

> A lógica das ferramentas de IV Rank (cálculo, cache de 4h, lotes de 3 com 300ms)
> vive em `src/utils/iv_calculator.ts` para manter o `index.ts` enxuto e o SSE estável.

---

## Infraestrutura GCP

### Região: `us-east1` (crítico)

O Claude Web e Mobile se conectam a partir de servidores da Anthropic localizados nos **Estados Unidos**. Hospedar o servidor MCP em `southamerica-east1` (São Paulo) introduz ~200 ms de latência transcontinental **em cada mensagem SSE**, o que frequentemente ultrapassa o timeout de handshake do cliente MCP.

**Sempre use `us-east1` (South Carolina) para servidores MCP conectados ao Claude.**

### Artifact Registry

```bash
# Criar repositório de imagens (uma vez)
gcloud artifacts repositories create oplab-mcp \
  --repository-format=docker \
  --location=us-east1 \
  --project=SEU_PROJECT_ID

# Autenticar Docker
gcloud auth configure-docker us-east1-docker.pkg.dev
```

### Secret Manager

O token da OpLab contém caracteres especiais (`/`, `=`, `-`). Armazená-lo no Secret Manager e injetá-lo via `--set-secrets` é a única forma segura — variáveis de ambiente em texto plano podem sofrer encoding incorreto dependendo do shell.

```bash
# Criar secret
echo -n "SEU_TOKEN_OPLAB" | gcloud secrets create OPLAB_ACCESS_TOKEN \
  --data-file=- \
  --project=SEU_PROJECT_ID

# Dar acesso à service account do Cloud Run
gcloud secrets add-iam-policy-binding OPLAB_ACCESS_TOKEN \
  --member="serviceAccount:SEU_SA@SEU_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

---

## Parâmetros de Produção do Cloud Run

Conexões SSE são **long-lived** (persistentes). O Cloud Run tem comportamentos padrão que precisam ser sobrescritos:

| Parâmetro | Valor | Por quê |
|---|---|---|
| `--no-cpu-throttling` | (flag) | Sem esse flag, o Cloud Run suspende a CPU de instâncias "ociosas". Uma conexão SSE aberta mas silenciosa parece ociosa — a CPU é suspensa, o processo congela e o cliente recebe timeout. |
| `--timeout=3600` | 3600 s (1 h) | Timeout padrão é 300 s. Conexões SSE ativas por mais de 5 minutos seriam derrubadas. |
| `--min-instances=1` | 1 | Elimina cold-start no handshake. Opcional mas recomendado. |
| `--max-instances=3` | 3 | Limita custo; cada instância suporta 1 sessão SSE ativa. |

### Deploy em um comando (recomendado)

Use o **`deploy.sh`** da raiz do repo. Ele cria o repositório do Artifact Registry
se faltar, faz build + push, faz o deploy com todos os parâmetros obrigatórios e
roda o health check no final:

```bash
# Projeto ativo do gcloud
./deploy.sh

# Ou explicitando o projeto
PROJECT_ID=oplab-mcp-server ./deploy.sh
```

Variáveis opcionais: `PROJECT_ID`, `REGION` (default `us-east1`), `REPO`
(default `oplab-mcp`), `SERVICE` (default `oplab-mcp-server`).

### Deploy via Cloud Build (CI / trigger)

O **`cloudbuild.yaml`** faz build + push + deploy num pipeline só:

```bash
gcloud builds submit --config cloudbuild.yaml .
```

Para deploy automático a cada push no `main`, crie um trigger apontando para esse
arquivo. A service account do Cloud Build precisa dos papéis `roles/run.admin` e
`roles/iam.serviceAccountUser` (instruções no topo do `cloudbuild.yaml`).

### Comandos manuais (referência)

<details>
<summary>Passo a passo sem o script</summary>

```bash
# 1. Build e push da imagem (de dentro do repo, onde está o Dockerfile)
gcloud builds submit \
  --tag us-east1-docker.pkg.dev/SEU_PROJECT_ID/oplab-mcp/server:latest \
  --project=SEU_PROJECT_ID

# 2. Deploy no Cloud Run
gcloud run deploy oplab-mcp-server \
  --image us-east1-docker.pkg.dev/SEU_PROJECT_ID/oplab-mcp/server:latest \
  --region us-east1 \
  --platform managed \
  --allow-unauthenticated \
  --set-secrets OPLAB_ACCESS_TOKEN=OPLAB_ACCESS_TOKEN:latest \
  --port 8080 \
  --no-cpu-throttling \
  --timeout=3600 \
  --min-instances=1 \
  --max-instances=3 \
  --project=SEU_PROJECT_ID

# 3. Verificar deploy
curl https://SUA_URL.run.app/health
# Resposta esperada: {"status":"ok","tools":32,"api":"reachable"}
```

</details>

---

## Configuração do Cliente MCP

No Claude Web/Mobile, adicionar conector com URL:

```
https://SUA_URL.run.app/sse
```

O cliente MCP envia um `GET /sse` para abrir o stream, depois envia mensagens JSON-RPC via `POST /messages`.

---

## Os Bugs Críticos — Core do Aprendizado

### Bug 1: `stream is not readable` no `POST /messages`

**Causa raiz:** `express.json()` (e qualquer body-parser global) lê e consome o stream Node.js da requisição antes que o SDK possa acessá-lo. O `SSEServerTransport.handlePostMessage()` usa a biblioteca `raw-body` para ler o stream diretamente — se o stream já foi consumido, lança `stream is not readable`.

**Solução:**

```typescript
// ❌ ERRADO — consome o stream globalmente
app.use(express.json());

// ✅ CORRETO — lê o body como string apenas nesta rota,
//   e passa como 3° argumento (parsedBody) para o SDK pular o raw-body
app.post("/messages",
  express.text({ type: "application/json" }),
  async (req: Request, res: Response) => {
    await sseTransport?.handlePostMessage(req, res, req.body as string);
  }
);
```

**Por que funciona:** O SDK tem assinatura `handlePostMessage(req, res, parsedBody?)`. Quando `parsedBody` é fornecido (não-undefined), o SDK pula a chamada ao `raw-body` completamente e usa a string diretamente com `JSON.parse()`. O stream nunca é retocado.

---

### Bug 2: `Este conector não possui ferramentas disponíveis`

**Causa raiz:** A tentativa de usar `McpServer.registerTool()` com shapes Zod dinâmicos falhou de duas formas:

1. **Schema silenciosamente corrompido:** O cast `(server.registerTool as any)` contornava a validação TypeScript, mas o runtime chamava `getZodSchemaObject(shape)` que, dependendo de como os valores `ZodTypeAny` passam pelo `isZodTypeLike()`, pode armazenar `inputSchema = undefined`. O Claude recebia ferramentas sem schema e as descartava.

2. **Reconnect quebrando o servidor:** `Protocol.connect()` lança `"Already connected to a transport"` se `this._transport` ainda estiver setado de uma conexão anterior (o `onclose` pode não ter disparado antes da nova conexão chegar).

**Solução:**

```typescript
// ❌ EVITAR — McpServer com registerTool dinâmico
const server = new McpServer({ name: "...", version: "1.0.0" });
(server.registerTool as any)(name, { inputSchema: shape }, cb);

// ✅ CORRETO — Server de baixo nível com lista estática
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// Lista construída uma vez no boot, retornada verbatim
const TOOLS_LIST = TOOL_REGISTRY.map(({ name, description, properties, required }) => ({
  name,
  description,
  inputSchema: { type: "object" as const, properties, required },
}));

const server = new Server(
  { name: "oplab-mcp-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS_LIST }));
server.setRequestHandler(CallToolRequestSchema, async (request) => { /* ... */ });

// Fechar transporte anterior antes de reconectar
app.get("/sse", async (_req, res) => {
  if (sseTransport) {
    await sseTransport.close();
    sseTransport = null;
  }
  sseTransport = new SSEServerTransport("/messages", res);
  await server.connect(sseTransport);
});
```

---

### Bug 3: Timeout do Cloud Run (`Truncated response body`)

**Causa raiz:** O servidor criava uma nova instância `Server` por conexão SSE (`createMcpServer()` dentro do handler `GET /sse`). O `await server.connect(transport)` bloqueava o handler Express até a conexão SSE fechar (nunca, voluntariamente) — o Cloud Run derrubava com timeout.

**Solução:** Instanciar `Server` uma única vez no escopo do módulo (singleton) e registrar handlers uma vez. A rota `/sse` apenas cria um `SSEServerTransport` e chama `server.connect()`, que retorna imediatamente.

---

## As 31 Ferramentas

### 29 Ferramentas de Market (mapeiam 1:1 para um GET via `build`)

| Grupo | Ferramenta | Endpoint |
|---|---|---|
| Taxas de juros | `get_interest_rates` | `GET /market/interest_rates` |
| | `get_interest_rate` | `GET /market/interest_rates/{id}` |
| Opções | `get_instrument_options` | `GET /market/options/{symbol}` |
| | `get_option` | `GET /market/options/details/{symbol}` |
| | `get_covered_options` | `GET /market/options/strategies/covered` |
| | `get_options_bs` | `GET /market/options/bs` |
| | `get_options_powders` | `GET /market/options/powders` |
| Cotação | `get_quote` | `GET /market/quote` |
| Instrumentos | `search_instruments` | `GET /market/instruments/search` |
| | `get_instrument_series` | `GET /market/instruments/series/{symbol}` |
| | `get_instrument` | `GET /market/instruments/{symbol}` |
| | `get_instruments_detail` | `GET /market/instruments` |
| Status | `get_market_status` | `GET /market/status` |
| Companhias | `get_companies` | `GET /market/companies` |
| Ações | `get_stocks` | `GET /market/stocks` |
| | `get_stocks_all` | `GET /market/stocks/all` |
| | `get_stock` | `GET /market/stocks/{symbol}` |
| Estatísticas RT | `get_highest_options_volume` | `GET /market/statistics/realtime/highest_options_volume` |
| | `get_best_covered_options_rates` | `GET /market/statistics/realtime/best_covered_options_rates/{type}` |
| | `get_highest_options_variation` | `GET /market/statistics/realtime/highest_options_variation/{type}` |
| Rankings | `get_m9m21_ranking` | `GET /market/statistics/ranking/m9_m21` |
| | `get_correl_ibov_ranking` | `GET /market/statistics/ranking/correl_ibov` |
| | `get_companies_ranking` | `GET /market/statistics/ranking/{attribute}` |
| | `get_oplab_score_ranking` | `GET /market/statistics/ranking/oplab_score` |
| Histórico | `get_historical_data` | `GET /market/historical/{symbol}/{resolution}` |
| | `get_historical_options` | `GET /market/historical/options/{spot}/{from}/{to}` |
| | `get_historical_instruments` | `GET /market/historical/instruments` |
| Bolsas | `get_exchanges` | `GET /market/exchanges` |
| | `get_exchange` | `GET /market/exchanges/{uid}` |

### 2 Ferramentas Compostas de IV Rank (usam `handler` em `src/utils/iv_calculator.ts`)

| Ferramenta | O que faz | Endpoints OpLab usados internamente |
|---|---|---|
| `get_iv_rank_historico` | IV Rank + IV Percentile de **um** ativo, com classificação operacional e histórico mensal | `GET /market/historical/{ticker}/1d` + `GET /market/stocks/{ticker}` |
| `get_iv_rank_bulk` | IV Rank de **vários** ativos (whitelist padrão de 24), ranqueados por IV Rank decrescente + resumo | os dois acima, por ticker, em lotes |

#### Como o IV Rank é calculado

1. **Série de volatilidade realizada:** busca o histórico diário (`/market/historical`),
   calcula retornos logarítmicos e a volatilidade rolling de 21 dias anualizada
   (`std × √252 × 100`) ao longo da janela (`periodo`: 21, 63, 126 ou 252 dias úteis).
2. **IV atual:** lê `iv_current` de `/market/stocks/{ticker}` (`iv_fonte: "implicita"`).
   A chain `/market/options/{ticker}` **não** expõe IV e tem ~4MB por ativo, então não é
   usada aqui. Sem `iv_current`, cai para a vol. realizada de 21d mais recente
   (`iv_fonte: "historica"`).
3. **IV Rank** = `(iv_atual − min) / (max − min) × 100` (limitado a 0–100).
   **IV Percentile** = % de dias da série com vol < iv_atual.
4. **Classificação:** `≥70` MUITO_ALTA · `50–69` ALTA · `30–49` MEDIA · `<30` BAIXA.

#### Qualidade do sinal (campos adicionais)

Além do IV Rank do período solicitado, `get_iv_rank_historico` retorna:

- **`historico_insuficiente` / `dias_disponiveis` / `aviso`** — ativos com `< 126`
  dias úteis têm `classificacao: "INSUFICIENTE"` (o `iv_min` dos primeiros pregões
  distorce o rank). Entre 126 e o período pedido, calcula com dados parciais e avisa.
- **`multi_periodo`** — IV Rank nas 4 janelas (21/63/126/252d) calculado de uma vez,
  sem chamadas extras (reaproveita o histórico já baixado).
- **`consenso` / `consenso_sinal` / `consenso_confianca`** — confirmação cruzando
  63d e 126d. Quando as duas janelas concordam, confiança `ALTA`; quando divergem,
  `DIVERGENTE` com confiança `BAIXA`. É informação **adicional** — `classificacao` e
  `sinal_operacional` continuam baseados no período solicitado.
- **`alerta_evento` / `alerta_evento_msg`** — quando `iv_atual > 2× iv_media_periodo`
  (possível evento corporativo); o `sinal_operacional` vira `⚠️ VERIFICAR EVENTO`.

No `get_iv_rank_bulk`, o campo **`triagem`** classifica os ativos em três listas:
`prontos_para_operar` (consenso ALTA/MUITO_ALTA, confiança ALTA, sem alertas),
`verificar_antes` (divergente ou alerta de evento) e `descartar` (histórico insuficiente).

#### Cache e rate limit

- **Cache em memória (TTL 4h)** por `ticker_periodo`. Tickers em cache não consomem
  chamadas à API; a 2ª chamada retorna `cache_hit: true` instantaneamente.
- **Concorrência limitada:** o bulk processa os tickers sem cache em **lotes de 3 com
  300ms entre lotes** (`batchWithLimit`), evitando HTTP 429 da OpLab.

#### Exemplo de uso (Protocolo 2 — triagem de venda de opções)

```
get_iv_rank_bulk()        → mantém classificacao ALTA ou MUITO_ALTA (descarta iv_rank < 30)
get_tendencia_m9m21()     → mantém tendência de alta
get_maiores_volumes()     → confirma liquidez (volume PUT > R$5M)
get_screener_quantitativo() → Nota Quantamental + Delta
get_options_bs()          → Delta Black-Scholes de confirmação
```

### Ferramenta de Backtesting (`handler` em `src/utils/backtest_engine.ts`)

| Ferramenta | O que faz |
|---|---|
| `get_backtest_protocolo2` | **Analítica — apenas simula, não executa ordens.** Backtesting histórico do Protocolo 2 (venda de PUTs OTM) |

Para cada ativo, em cada dia útil do período, a engine:

1. **Filtros de entrada** — IV Rank do dia `≥ iv_rank_min` (vol. realizada de 21d ranqueada); tendência `M9/M21 ≥ 1.0` (se `m9m21_filter`). O filtro de volume de PUT é marcado como `volume_nao_verificado` (não há volume de opções no histórico da OpLab).
2. **Seleção da PUT** — em `/market/historical/options/{ticker}/{date}/{date}`, filtra PUTs com `delta ∈ [delta_min, delta_max]`, `DTE ∈ [dte_min, dte_max]` e `premium > 0`; escolhe a de delta mais próximo do centro do range (desempate por maior prêmio).
3. **Simulação no vencimento** — duas estruturas:
   - **`NAKED_PUT`** (padrão): `WIN` se `spot > strike` (captura 100% do prêmio); `LOSS` caso contrário (`(premium − (strike − spot)) × 100`). Margem = `strike × 100 × 0.22`. Perda potencialmente grande.
   - **`BULL_PUT_SPREAD`** (`use_spread=true`): além da PUT vendida, compra a PUT de proteção do mesmo vencimento com strike ≈ `strike − spread_width` (usa o prêmio real da cadeia). Ganho máx = crédito líquido; **perda máx = `(largura − crédito líquido) × 100`** (limitada). Margem = risco máximo. Campos extra: `estrutura`, `strike_protecao`, `premio_protecao`, `premio_liquido`, `perda_maxima`.
4. **Anti-sobreposição** — não abre nova operação no mesmo ativo enquanto há uma pendente.

O retorno traz `resumo_geral`, **`comparativo_filtros`** (com/sem cada filtro — prova estatística do valor do protocolo, sempre calculado), `por_ativo`, `por_mes`, `curva_capital` e `alertas`.

- **Cache de 24h** por combinação de parâmetros (backtest histórico não muda).
- **Lotes de 3 ativos com 500ms** entre lotes (mais conservador que o IV Rank, pois o volume de dados é maior); timeout de 10s por ativo; período máximo de 2 anos.

```bash
# Backtest de 1 ativo, 3 meses (PUT a descoberto)
get_backtest_protocolo2(tickers=["VALE3"], data_inicio="2025-01-01", data_fim="2025-03-31")
# Com trava Bull Put Spread (perda limitada), largura de R$3
get_backtest_protocolo2(tickers=["VALE3"], use_spread=true, spread_width=3.00)
# Backtest completo (24 ativos, 2 anos) — sem parâmetros
get_backtest_protocolo2()
```

---

## Desenvolvimento Local

```bash
# Instalar dependências
npm install

# Compilar TypeScript
npm run build

# Rodar localmente (requer OPLAB_ACCESS_TOKEN no ambiente)
OPLAB_ACCESS_TOKEN="seu_token" npm start

# Testar health check
curl http://localhost:8080/health
# Resposta esperada: {"status":"ok","tools":32,"api":"reachable"}
```
