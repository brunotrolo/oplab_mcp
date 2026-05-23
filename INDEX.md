# INDEX.md — Mapa de Calor do Codebase

Use este arquivo como ponto de entrada antes de qualquer leitura de código.
Descreve onde cada responsabilidade vive e como os dados fluem.

---

## Fluxo de Dados

```
Claude Web/Mobile
    │
    ├─ GET /sse ──────────────────────────────────► SSEServerTransport
    │                                                     │
    └─ POST /messages (JSON-RPC) ─────────────────► handlePostMessage(req, res, req.body)
                                                          │
                                              server.setRequestHandler()
                                                    │           │
                                          ListTools (estático)  CallTool
                                          TOOLS_LIST[]          TOOL_REGISTRY.find()
                                                                      │
                                                               entry.build(args)
                                                                      │
                                                          oplabClient.get(path, params)
                                                                      │
                                                         api.oplab.com.br/v3/market/...
```

---

## Mapa de Arquivos

| Arquivo / Pasta | Responsabilidade | Mexer quando? |
|---|---|---|
| `src/index.ts` | **Todo o servidor** — único arquivo de aplicação | Adicionar ferramenta, corrigir rota, ajustar auth |
| `Dockerfile` | Build multi-stage node:20-slim | Mudar versão Node, adicionar dep de sistema |
| `.dockerignore` | Exclusões do contexto Docker | Adicionar pastas geradas |
| `tsconfig.json` | Configuração TypeScript | Nunca, exceto mudança de target/module |
| `package.json` | Dependências e scripts | Adicionar/atualizar pacote |
| `CLAUDE.md` | Regras para assistentes de IA | Após cada bug crítico resolvido |
| `INDEX.md` | Este arquivo — mapa do codebase | Após refatoração estrutural |
| `.claude/settings.json` | Comandos pré-aprovados para Claude Code | Adicionar novo comando de deploy |
| `.claude/rules/` | Regras de escopo por domínio | Após aprender nova restrição importante |

---

## Blocos Internos de `src/index.ts`

Leia nesta ordem para entender o arquivo completo:

```
Linha ~1    imports
Linha ~15   createOplabClient()     ← lê OPLAB_ACCESS_TOKEN, cria Axios instance
Linha ~28   interface PropDef       ← tipo de propriedade do JSON Schema
Linha ~35   interface ToolDef       ← tipo de entrada do TOOL_REGISTRY
Linha ~44   TOOL_REGISTRY[]         ← 29 ferramentas de market (NÃO REORDENAR)
Linha ~360  pick()                  ← helper: filtra undefined de query params
Linha ~365  TOOLS_LIST              ← derivado de TOOL_REGISTRY, estático, imutável
Linha ~372  oplabClient             ← singleton Axios
Linha ~380  server                  ← singleton Server (MCP SDK low-level)
Linha ~382  setRequestHandler(List) ← retorna TOOLS_LIST verbatim
Linha ~384  setRequestHandler(Call) ← despacha para entry.build() + axios.get
Linha ~410  Express app             ← sem middleware global
Linha ~414  GET /health             ← health check do Cloud Run
Linha ~418  GET /sse                ← cria SSEServerTransport, server.connect()
Linha ~425  POST /messages          ← express.text() + handlePostMessage(req,res,body)
Linha ~432  app.listen()
```

---

## Dependências-Chave e Por Que Existem

| Pacote | Versão | Motivo |
|---|---|---|
| `@modelcontextprotocol/sdk` | ^1.12 | Server, SSEServerTransport, schemas JSON-RPC |
| `express` | ^4 | HTTP server + middleware de texto na rota /messages |
| `axios` | ^1.9 | HTTP client para a API OpLab (timeout, headers centralizados) |
| `zod` | ^3 | Instalado como dep transitiva do SDK — **não usado diretamente** |

---

## Onde NÃO existe código (por design)

- **Sem `/src/tools/`** — ferramentas são entradas do array `TOOL_REGISTRY` em `index.ts`
- **Sem `/src/services/`** — a lógica de chamada HTTP cabe em 3 linhas dentro do handler
- **Sem testes** — estrutura simples o suficiente para validação manual via `/health`
- **Sem banco de dados / estado persistente** — servidor stateless (Cloud Run padrão)
