# OpLab MCP Server

Servidor MCP (Model Context Protocol) construído em TypeScript/Node.js sobre Express, com transporte SSE (Server-Sent Events), hospedado no Google Cloud Run. Expõe 29 ferramentas cobrindo toda a seção **Market** da API REST da OpLab v3.

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
│   └── index.ts          # Único arquivo de aplicação
├── dist/                 # Saída do tsc (gerada)
├── Dockerfile            # Multi-stage build (builder + runtime)
├── .dockerignore
├── package.json
├── tsconfig.json
├── CLAUDE.md             # Guia para assistentes de IA
└── README.md             # Este arquivo
```

### `src/index.ts` — estrutura interna

| Bloco | Responsabilidade |
|---|---|
| `createOplabClient()` | Cria instância Axios com `Access-Token` header |
| `interface PropDef / ToolDef` | Tipos do registro de ferramentas |
| `TOOL_REGISTRY` | Array com os 29 endpoints mapeados |
| `pick()` | Helper para filtrar parâmetros opcionais undefined |
| `TOOLS_LIST` | Lista estática derivada de `TOOL_REGISTRY` (retornada no `ListTools`) |
| `server` (singleton) | `Server` do SDK, handlers registrados uma vez |
| Express routes | `/health`, `/sse`, `/messages` |

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

### Comandos de Deploy

```bash
# 1. Build e push da imagem
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
# Resposta esperada: {"status":"ok","tools":29}
```

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

## As 29 Ferramentas de Market

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
```
