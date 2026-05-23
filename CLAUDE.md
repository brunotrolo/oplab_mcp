# CLAUDE.md — Guia de Contexto para Assistentes de IA

Este arquivo descreve a arquitetura, padrões e regras de manutenção do **OpLab MCP Server**. Leia antes de fazer qualquer alteração.

---

## Contexto do Projeto

Servidor MCP (Model Context Protocol) em TypeScript/Express que expõe 29 ferramentas da API REST da OpLab v3, via transporte SSE, hospedado no Google Cloud Run (região `us-east1`).

Arquivo principal: **`src/index.ts`** (único arquivo de aplicação, ~450 linhas).

---

## Comandos Essenciais

```bash
# Compilar TypeScript (sempre rode antes de commitar)
npm run build

# Rodar localmente
OPLAB_ACCESS_TOKEN="token" npm start

# Health check local
curl http://localhost:8080/health
# Esperado: {"status":"ok","tools":29}

# Build da imagem Docker
docker build -t oplab-mcp-server .

# Deploy no Cloud Run (substitua as variáveis)
gcloud builds submit \
  --tag us-east1-docker.pkg.dev/PROJECT/oplab-mcp/server:latest

gcloud run deploy oplab-mcp-server \
  --image us-east1-docker.pkg.dev/PROJECT/oplab-mcp/server:latest \
  --region us-east1 \
  --no-cpu-throttling \
  --timeout=3600 \
  --set-secrets OPLAB_ACCESS_TOKEN=OPLAB_ACCESS_TOKEN:latest
```

---

## Estrutura do Código (`src/index.ts`)

O arquivo segue esta ordem estrita:

```
1. Imports
2. createOplabClient()       — cliente Axios (lê OPLAB_ACCESS_TOKEN)
3. interfaces PropDef / ToolDef
4. TOOL_REGISTRY[]           — 29 entradas, cada uma com: name, description,
                               properties, required, build()
5. pick()                    — helper para filtrar params undefined
6. TOOLS_LIST                — derivado de TOOL_REGISTRY, retornado verbatim no ListTools
7. oplabClient (singleton)
8. server (Server singleton) — handlers registrados UMA VEZ aqui
9. Express app + rotas       — /health, /sse, /messages
10. app.listen()
```

---

## Regras Críticas de Arquitetura

### 1. Nunca use `express.json()` globalmente

```typescript
// ❌ PROIBIDO — quebra o stream do /messages
app.use(express.json());

// ✅ CORRETO — body-parser apenas na rota /messages, como texto
app.post("/messages",
  express.text({ type: "application/json" }),
  async (req, res) => {
    await sseTransport?.handlePostMessage(req, res, req.body as string);
  }
);
```

**Por quê:** `SSEServerTransport.handlePostMessage(req, res, parsedBody?)` pula o `raw-body` interno quando `parsedBody` é fornecido. Se qualquer middleware consumir o stream antes, o SDK lança `stream is not readable`.

### 2. O `Server` MCP deve ser singleton

```typescript
// ❌ PROIBIDO — cria novo Server por conexão SSE (causa timeout no Cloud Run)
app.get("/sse", async (req, res) => {
  const server = new Server(...);        // ERRADO
  server.setRequestHandler(...);         // ERRADO
  await server.connect(transport);
});

// ✅ CORRETO — Server instanciado UMA VEZ no módulo
const server = new Server({ name: "...", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, ...);  // registrado uma vez
server.setRequestHandler(CallToolRequestSchema, ...);   // registrado uma vez

app.get("/sse", async (req, res) => {
  if (sseTransport) { await sseTransport.close(); sseTransport = null; }
  sseTransport = new SSEServerTransport("/messages", res);
  await server.connect(sseTransport);   // apenas conecta o transport
});
```

### 3. Nunca use `McpServer` com shapes Zod dinâmicos

`McpServer.registerTool()` + shapes construídos em runtime são incompatíveis com TypeScript estrito (TS2589) e podem silenciosamente armazenar `inputSchema = undefined`, fazendo o Claude descartar as ferramentas. Use `Server` de baixo nível com `TOOLS_LIST` estático.

### 4. A lista de ferramentas deve ser estática

```typescript
// ✅ CORRETO — derivado do TOOL_REGISTRY no boot, retornado verbatim
const TOOLS_LIST = TOOL_REGISTRY.map(({ name, description, properties, required }) => ({
  name,
  description,
  inputSchema: { type: "object" as const, properties, required },
}));

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS_LIST }));
```

O Claude Web/Mobile faz cache da lista de ferramentas. Se a lista for dinâmica ou retornar vazia em algum momento, o cache fica corrompido e o erro "Este conector não possui ferramentas disponíveis" persiste mesmo após correção.

---

## Como Adicionar uma Nova Ferramenta

1. Adicione uma entrada no `TOOL_REGISTRY` em `src/index.ts`:

```typescript
{
  name: "nome_da_ferramenta",         // snake_case, único
  description: "Descrição clara...",  // aparece no Claude
  properties: {
    param1: { type: "string", description: "..." },
    param2: { type: "integer", description: "..." },
    param3: { type: "string", description: "...", enum: ["A", "B"] },
  },
  required: ["param1"],               // params obrigatórios
  build: (a) => ({
    path: `/market/endpoint/${a.param1}`,
    params: pick(a, ["param2", "param3"]),  // só inclui se não-undefined
  }),
},
```

2. Execute `npm run build` — deve compilar sem erros.

3. O `TOOLS_LIST` é derivado automaticamente do `TOOL_REGISTRY` — não precisa de nenhuma outra alteração.

**Tipos disponíveis para `properties`:**

| `type` | Tipo TypeScript em `args` | Notas |
|---|---|---|
| `"string"` | `string` | padrão |
| `"number"` | `number` | float |
| `"integer"` | `number` | inteiro |
| `"boolean"` | `boolean` | |
| (com `enum`) | `string` | enum é sempre string no JSON Schema |

---

## Configuração TypeScript

`tsconfig.json`:
- `target`: ES2022
- `module`: CommonJS (necessário para `require` do Node.js)
- `strict`: true
- `esModuleInterop`: true — permite `import axios from "axios"` sem `* as`
- `resolveJsonModule`: true

**Imports do SDK sempre com `.js` no final** (mesmo sendo `.ts` em desenvolvimento):
```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
```

---

## Variáveis de Ambiente

| Variável | Obrigatória | Descrição |
|---|---|---|
| `OPLAB_ACCESS_TOKEN` | Sim | Token de acesso à API OpLab. Injetado via Secret Manager no Cloud Run. Lido com `?.trim()` para remover whitespace invisível. |
| `PORT` | Não | Porta do servidor Express. Padrão: `8080` (exigido pelo Cloud Run). |

---

## Configuração do Cloud Run (Produção)

| Parâmetro | Valor | Motivo |
|---|---|---|
| Região | `us-east1` | Anthropic usa servidores nos EUA; latência transcontinental quebra o handshake SSE |
| `--no-cpu-throttling` | obrigatório | Sem isso, Cloud Run suspende CPU de conexões SSE "ociosas" |
| `--timeout` | `3600` | SSE é long-lived; timeout padrão de 300 s derruba sessões ativas |
| `--min-instances` | `1` | Evita cold-start no handshake |
| Segredos | Secret Manager | Token tem chars especiais; env vars em texto plano podem ser corrompidas |

---

## Rotas do Servidor

| Rota | Método | Descrição |
|---|---|---|
| `/health` | GET | Health check. Retorna `{"status":"ok","tools":29}`. Usado pelo Cloud Run. |
| `/sse` | GET | Abre conexão SSE. Fecha transporte anterior se existir. Retorna stream infinito. |
| `/messages` | POST | Recebe mensagens JSON-RPC do cliente MCP. Usa `express.text()` + `parsedBody`. |

---

## O que NÃO Fazer

- Não adicione `app.use(express.json())` em nenhum lugar — quebra o stream do `/messages`
- Não instancie `Server` ou registre handlers dentro de rotas Express — causa timeout
- Não use `McpServer` de `server/mcp.js` — incompatível com shapes Zod dinâmicos
- Não hospede em `southamerica-east1` — latência quebra o handshake SSE do Claude Web
- Não armazene o `OPLAB_ACCESS_TOKEN` em texto plano em variáveis de ambiente do Cloud Run — use Secret Manager
- Não remova o `req.body as string` do terceiro argumento do `handlePostMessage` — causa `stream is not readable`
- Não esqueça de fechar o `sseTransport` anterior antes de criar um novo em `/sse`
