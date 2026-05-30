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
                                                  ┌───────────────────┴───────────────────┐
                                                  │ tem handler?                           │
                                            sim ──┤                                        ├── não
                                                  ▼                                        ▼
                                    entry.handler(client, args)                     entry.build(args)
                                  (src/utils/iv_calculator.ts:                             │
                                   cache 4h + lotes de 3)                     oplabClient.get(path, params)
                                                  │                                        │
                                                  └────────────► api.oplab.com.br/v3/market/... ◄────────┘
```

---

## Mapa de Arquivos

| Arquivo / Pasta | Responsabilidade | Mexer quando? |
|---|---|---|
| `src/index.ts` | Servidor + `TOOL_REGISTRY` (rotas SSE, dispatch `build`/`handler`) | Adicionar ferramenta simples, corrigir rota, ajustar auth |
| `src/utils/iv_calculator.ts` | Matemática de IV Rank, cache 4h, lotes de 3 (ferramentas compostas) | Ajustar cálculo/cache/lote das ferramentas de IV Rank |
| `Dockerfile` | Build multi-stage node:20-slim | Mudar versão Node, adicionar dep de sistema |
| `cloudbuild.yaml` | Pipeline build+push+deploy (Cloud Build/trigger) | Mudar passos de CI ou parâmetros de deploy |
| `deploy.sh` | Deploy completo em um comando (credenciais locais) | Mudar fluxo de deploy manual |
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
imports                  ← inclui getIVRankHistorico/getIVRankBulk de ./utils/iv_calculator.js
createOplabClient()      ← lê OPLAB_ACCESS_TOKEN, cria Axios instance
interface PropDef        ← tipo de propriedade do JSON Schema (type, enum, items)
interface ToolDef        ← entrada do TOOL_REGISTRY: tem build? OU handler?
TOOL_REGISTRY[]          ← 31 ferramentas: 29 com build, 2 (IV Rank) com handler (NÃO REORDENAR)
pick()                   ← helper: filtra undefined de query params
withRetry()              ← retry com backoff só em 5xx
TOOLS_LIST               ← derivado de TOOL_REGISTRY, estático, imutável
oplabClient              ← singleton Axios
server                   ← singleton Server (MCP SDK low-level)
setRequestHandler(List)  ← retorna TOOLS_LIST verbatim
setRequestHandler(Call)  ← se entry.handler: handler(client,args); senão build() + axios.get
GET /health              ← health check do Cloud Run ({"tools":31,...})
GET /sse                 ← cria SSEServerTransport, server.connect()
POST /messages           ← express.text() + handlePostMessage(req,res,body)
app.listen()
```

### `src/utils/iv_calculator.ts` — blocos internos

```
calcRetornosLog / calcVolatilidade21d / calcIVRank / calcIVPercentile / classificarIVRank
                         ← funções matemáticas PURAS (sem I/O, fáceis de testar)
ivCache (Map) + CACHE_TTL_MS=4h
                         ← cache em memória por `${ticker}_${periodo}`
batchWithLimit()         ← concorrência limitada (lotes de 3, 300ms) → evita HTTP 429
WHITELIST_24             ← lista padrão de tickers do bulk
getIVRankHistorico()     ← orquestra 1 ticker: histórico + iv_current → resultado
getIVRankBulk()          ← cache-first, depois lotes, ordena por iv_rank desc
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

## Convenções de código

- **Ferramentas simples** (1 GET) → entrada com `build` no `TOOL_REGISTRY` em `index.ts`.
- **Ferramentas compostas** (múltiplas chamadas, cálculo, cache) → entrada com `handler`,
  e a lógica vai para `src/utils/` (ex: `iv_calculator.ts`). Mantém o `index.ts` enxuto
  e o transporte SSE estável.
- **Sem `/src/services/`** — para ferramentas simples a chamada HTTP cabe no próprio handler.
- **Cache em memória** — o `ivCache` é por instância. Com `--max-instances>1` cada instância
  tem o seu cache (aceitável: TTL curto de 4h). Estado persistente continua não existindo.
- **Testes** — funções de `iv_calculator.ts` são puras e validáveis isoladamente; o restante
  é validado via `/health` e chamadas reais.
