# Regra: MCP Server — Padrões Obrigatórios

**Escopo:** ativada sempre que `src/index.ts` for modificado.

---

## 1. `Server` de Baixo Nível — Nunca `McpServer`

```typescript
// ✅ CORRETO — import do server de baixo nível
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// ❌ PROIBIDO — McpServer com registerTool dinâmico
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
```

**Motivo:** `McpServer.registerTool()` com shapes Zod dinâmicos falha de duas formas:
- Cast `as any` → `inputSchema = undefined` silencioso → Claude descarta ferramentas
- `Protocol.connect()` lança `"Already connected"` em reconexão SSE

---

## 2. `TOOLS_LIST` Estático — Nunca Dinâmico

```typescript
// ✅ CORRETO — derivado de TOOL_REGISTRY no boot, imutável
const TOOLS_LIST = TOOL_REGISTRY.map(({ name, description, properties, required }) => ({
  name,
  description,
  inputSchema: { type: "object" as const, properties, required },
}));

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS_LIST }));
```

**Motivo:** Claude Web/Mobile faz cache da lista. Se retornar vazio uma vez,
o erro "Este conector não possui ferramentas disponíveis" persiste por horas.

---

## 3. `Server` Singleton — Handlers Registrados Uma Vez

```typescript
// ✅ CORRETO — fora de qualquer rota Express
const server = new Server(
  { name: "oplab-mcp-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);
server.setRequestHandler(ListToolsRequestSchema, ...); // uma vez
server.setRequestHandler(CallToolRequestSchema, ...);  // uma vez

// ❌ PROIBIDO — dentro de app.get("/sse", ...)
app.get("/sse", async (req, res) => {
  const server = new Server(...); // cria novo Server por conexão → timeout
  server.setRequestHandler(...);  // registra handlers por conexão → timeout
});
```

---

## 4. Fechar Transporte Anterior em `/sse`

```typescript
// ✅ OBRIGATÓRIO — fecha antes de reconectar
app.get("/sse", async (_req, res) => {
  if (sseTransport) {
    await sseTransport.close();  // libera this._transport no Protocol
    sseTransport = null;
  }
  sseTransport = new SSEServerTransport("/messages", res);
  await server.connect(sseTransport);
});
```

**Motivo:** `Protocol.connect()` lança `"Already connected to a transport"` se
`this._transport` ainda estiver definido da conexão anterior.

---

## 5. Imports com `.js` no Final

```typescript
// ✅ CORRETO — mesmo em TypeScript, o module resolver do Node precisa do .js
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// ❌ ERRADO
import { Server } from "@modelcontextprotocol/sdk/server/index";
```

---

## 6. Como Adicionar uma Nova Ferramenta

Adicione **apenas** uma entrada no `TOOL_REGISTRY`. O `TOOLS_LIST` é derivado automaticamente.

```typescript
{
  name: "nome_unico",               // snake_case
  description: "Descrição clara",   // exibida no Claude
  properties: {
    param1: { type: "string",  description: "..." },
    param2: { type: "integer", description: "..." },
    param3: { type: "string",  description: "...", enum: ["A", "B"] },
  },
  required: ["param1"],
  build: (a) => ({
    path: `/market/rota/${a.param1}`,
    params: pick(a, ["param2", "param3"]),
  }),
},
```

Verificar após adicionar:
```bash
npm run build  # deve compilar sem erros
curl http://localhost:8080/health | python3 -m json.tool
# "tools" deve ser o número anterior + 1
```
