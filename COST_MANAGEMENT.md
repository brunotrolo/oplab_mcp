# 🏛️ Arquitetura de Referência — MCP Server no Google Cloud Run **barato e confiável**

> Documento vivo, escrito a partir de um caso real: dois MCPs (OpLab e Google Sheets)
> no Cloud Run que passaram de **~R$ 150/mês de surpresa** para **R$ 0 (dentro do free tier)**
> — e que só ficaram **estáveis no app do Claude** depois de acertar o padrão de servidor.
> Use isto como **checklist obrigatório** ao criar qualquer MCP novo. Cada regra aqui
> custou caro (em dinheiro e em dor de cabeça) pra ser descoberta.

---

## 0. TL;DR — As 6 regras de ouro

| # | Regra | Flag / Padrão |
|---|-------|---------------|
| 1 | **CPU só durante a requisição** (nunca "sempre alocada") | `--cpu-throttling` |
| 2 | **Escale a zero** quando ocioso | `--min-instances=0` |
| 3 | **Transporte HTTP stateless** (NUNCA SSE de longa duração) | `StreamableHTTPServerTransport` |
| 4 | **Timeout curto** (a conexão não pode ficar pendurada) | `--timeout=120` |
| 5 | **Teto de instâncias** pra acidente não escalar | `--max-instances=2` |
| 6 | **Servidor NOVO por requisição** (nunca compartilhado) | `createServer()` por chamada |

Regras 1-5 fazem o MCP **caber no free tier (R$ 0)**. A regra 6 faz ele **funcionar de forma
confiável no app do Claude** (clientes concorrentes). As duas coisas são obrigatórias.

---

## 1. Como o Cloud Run cobra (entenda ou pague)

O Cloud Run (cobrança *request-based*) cobra **vCPU-segundos** e **GiB-segundos**
**enquanto a requisição está aberta** — do primeiro byte recebido até a resposta terminar.

> ⚠️ A consequência fatal: **uma conexão aberta = uma requisição "em andamento" = CPU sendo cobrada o tempo todo**, mesmo que nada esteja sendo processado.

**Free tier mensal** (por conta de faturamento, us-east1):
- 180.000 vCPU-segundos
- 360.000 GiB-segundos
- 2.000.000 de requisições

Para um MCP pessoal (~150 chamadas/dia, ~2s cada), isso dá folga de **~10x**. Você só
estoura isso se cometer um dos erros abaixo.

---

## 2. Os 3 vazamentos que mataram nosso custo (caso real)

### 🩸 Vazamento 1 — CPU "sempre alocada" (instance-based billing)
- **Sintoma:** custo fixo mesmo com o projeto parado.
- **Causa:** serviço com *"CPU is always allocated"* + `min-instances ≥ 1` → você paga CPU 24/7.
- **No caso real:** SKU `Services CPU (Instance-based billing)` = **R$ 39 num mês**, sem ninguém usar.
- **Correção:** `--cpu-throttling` (CPU só na requisição) + `--min-instances=0`.

### 🩸 Vazamento 2 — Timeout gigante segurando conexões
- **Sintoma:** poucas requisições, mas muitos segundos de CPU cobrados.
- **Causa:** `timeoutSeconds=3600` (1h) → uma conexão podia ficar **1 hora** aberta cobrando CPU.
- **No caso real:** duração média por requisição = **~190 segundos** (deveria ser ~2s).
- **Correção:** `--timeout=120` (ou o menor que sua ferramenta mais lenta exija).

### 🩸 Vazamento 3 — Transporte SSE (o verdadeiro vilão)
- **Sintoma:** o custo "estoura na tela" sempre que o MCP é usado, e continua enquanto conectado.
- **Causa:** `SSEServerTransport` mantém uma conexão `/sse` **aberta durante toda a sessão**.
  Pior ainda se houver um `setInterval(heartbeat)` "pra manter viva" — isso **derrota** o
  `cpu-throttling` e cobra CPU continuamente.
- **No caso real:** ~**188 segundos de CPU por chamada**. Após migrar pra stateless: **< 1,5s**. Redução de **~99%**.
- **Correção:** usar **Streamable HTTP stateless** (seção 4).

> 🚫 **NUNCA** adicione um heartbeat "pra impedir o Cloud Run de suspender a CPU".
> Suspender a CPU quando ocioso é **exatamente o que faz ficar de graça**.

---

## 3. Configuração de deploy recomendada (copie e cole)

```bash
gcloud run deploy SEU_MCP \
  --source . \
  --region us-east1 \
  --cpu=1 \
  --memory=512Mi \
  --cpu-throttling \          # CPU só durante a requisição (request-based)
  --min-instances=0 \         # escala a zero quando ocioso  -> custo parado = R$ 0
  --max-instances=2 \         # teto de segurança contra acidente
  --timeout=120 \             # conexão não fica pendurada
  --concurrency=80            # uma instância atende várias chamadas
```

> Variáveis sensíveis (tokens, credenciais) → **Secret Manager**, nunca no código/repo.

---

## 4. Padrão de código CORRETO — Streamable HTTP stateless

Cada chamada vira um POST que **responde e fecha**. Sem conexão pendurada, sem heartbeat.

```ts
import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// fábrica: um server por requisição (stateless, sem colisão de IDs)
function createServer(): Server {
  const server = new Server({ name: "meu-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS_LIST }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => { /* ... */ });
  return server;
}

const app = express();

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.post("/mcp", express.json(), async (req, res) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined }); // stateless
  res.on("close", () => { transport.close(); server.close(); });   // fecha tudo ao fim
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
  }
});

app.listen(Number(process.env.PORT ?? 8080));
```

- SDK mínimo: `@modelcontextprotocol/sdk@^1.12` (o `streamableHttp` não existe em versões < 1.10).
- O cliente (Claude) conecta na URL terminando em **`/mcp`** (não `/sse`).

### ❌ Anti-padrões (o que NÃO fazer)
```ts
// 1) NÃO: conexão aberta a sessão inteira + heartbeat = CPU cobrada continuamente
app.get("/sse", (req, res) => {
  const t = new SSEServerTransport("/messages", res);
  setInterval(() => res.write(": ping\n\n"), 30000); // 🚨 vaza dinheiro
});

// 2) NÃO: servidor ÚNICO compartilhado + close()/reconnect por requisição.
//    Funciona em cliente sequencial (curl, Claude Code), mas QUEBRA sob
//    requisições concorrentes (app do Claude) — race condition no connect/close.
const mcpServer = new Server(...);          // 🚨 compartilhado
let connected = false;
app.post("/mcp", async (req, res) => {
  if (connected) await mcpServer.close();   // 🚨 fecha no meio de outra requisição
  await mcpServer.connect(transport);
  connected = true;
});
```

> 💡 **Lição cara (caso real 2):** o MCP do Sheets usava o padrão 2 acima. Funcionava no
> Claude Code (chamadas sequenciais), mas **falhava nos chats do app** (chamadas
> concorrentes no handshake). O OpLab, com `createServer()` por requisição, sempre
> funcionou. A correção foi alinhar o Sheets ao padrão por-requisição — validado com
> **8 requisições concorrentes** sem erro.

---

## 4b. Confiabilidade & compatibilidade com clientes

Nem todo cliente MCP é igual. O **Claude Code** é tolerante; o **app do Claude (chats)**
é mais rígido e concorrente. Para funcionar nos dois:

| Item | Regra | Por quê |
|---|---|---|
| **Servidor por requisição** | `createServer()` a cada POST | Evita race condition sob concorrência (regra de ouro 6) |
| **serverInfo.name único** | ex.: `gs-controle-opcoes`, `oplab-oficial` | Evita confusão de registro entre múltiplos conectores |
| **Rota `/health`** | `app.get("/health", ...)` | Health-check externo sem depender do handshake |
| **Accept duplo** | cliente deve mandar `application/json, text/event-stream` | O SDK responde **406** se faltar um dos dois |
| **Endpoint `/mcp`** | não `/sse` | Streamable HTTP é o transporte atual |

### Ao trocar o endpoint (`/sse` → `/mcp`) ou redeployar
No **claude.ai**: **apague o conector antigo, adicione de novo com a URL `/mcp` e abra
uma conversa nova.** Conector velho/duplicado apontando pro `/sse` é a causa nº 1 de
"tool not found" / "invalid request" — é problema de **cliente**, não do servidor.

---

## 5. Monitoramento (de graça, sem infra nova)

Não monte infra paga pra controlar custo. Use o que já é gratuito:

- **Fonte:** Cloud Monitoring (`run.googleapis.com/container/billable_instance_time` e `request_count`) — quase tempo real.
- **Coleta:** GitHub Actions agendado (grátis) lê as métricas e grava um JSON no repo.
- **Custo estimado:** `tempo_faturável × (vCPU×preço_cpu + GiB×preço_mem) × câmbio`.
- **Free tier:** subtraia a cota grátis do mês antes de declarar "vou pagar".

### A métrica-canário: **segundos de CPU por chamada**
É o melhor sinal de saúde:
- **Saudável:** < ~5 s/chamada.
- **Doente:** dezenas/centenas de s/chamada → conexão pendurada (SSE/heartbeat/timeout alto voltou).

Acompanhe esse número. Se ele disparar, um dos 3 vazamentos regrediu.

---

## 6. Checklist pré-deploy de um MCP novo

- [ ] Transporte é **Streamable HTTP stateless** (`/mcp`), não SSE.
- [ ] **Servidor NOVO por requisição** (`createServer()`), nunca compartilhado.
- [ ] **Sem** `setInterval`/heartbeat mantendo conexão viva.
- [ ] `serverInfo.name` **único** e distinto dos outros MCPs.
- [ ] Rota **`/health`** existe.
- [ ] Deploy com `--cpu-throttling --min-instances=0 --max-instances=N --timeout=120`.
- [ ] Tokens/credenciais no **Secret Manager**.
- [ ] `gcloud run services describe` confirma: `cpu-throttling=true`, `minScale=0`.
- [ ] Teste: `curl -X POST .../mcp` com `initialize` responde e a conexão **fecha**.
- [ ] Teste de **concorrência**: várias chamadas paralelas a `tools/list` respondem todas.
- [ ] Métrica sec/chamada observada após 1 dia de uso real (< 5s).
- [ ] No claude.ai: conector recriado com URL `/mcp` + conversa nova.

---

## 7. Resumo do caso real (a prova)

### Custo (caso 1 — SSE/heartbeat/instance-based)
| Métrica | Antes | Depois |
|---|---|---|
| CPU por chamada | ~188 s | < 1,5 s |
| % do free tier (no mesmo uso) | ~400% (estourava) | ~3% |
| Custo mensal projetado | ~R$ 75–150 | **R$ 0** |
| Custo real/dia | R$ 3–10 | **R$ 0,02–0,07** |

### Confiabilidade (caso 2 — servidor compartilhado)
| Sintoma | Causa | Correção |
|---|---|---|
| Sheets falhava nos chats, OpLab não | Servidor compartilhado + reconnect (race sob concorrência) | `createServer()` por requisição (igual OpLab) |
| "tool not found" / "invalid request" | Conector velho/duplicado no claude.ai | Recriar conector com `/mcp` + conversa nova |

**Os MCPs continuam funcionando exatamente igual — só pararam de sangrar e ficaram estáveis.**
