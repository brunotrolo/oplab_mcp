# Regra: Express + SSE Stream — Nunca Quebre o /messages

**Escopo:** ativada sempre que `src/index.ts` ou qualquer arquivo Express for modificado.

---

## A Regra Principal

**NUNCA adicione `express.json()` ou qualquer body-parser no escopo global do app.**

```typescript
// ❌ PROIBIDO — qualquer uma dessas linhas quebra o stream do /messages
app.use(express.json());
app.use(bodyParser.json());
app.use(express.urlencoded({ extended: true }));

// ✅ ÚNICO padrão permitido para a rota /messages
app.post("/messages",
  express.text({ type: "application/json" }),
  async (req: Request, res: Response) => {
    await sseTransport?.handlePostMessage(req, res, req.body as string);
  }
);
```

## Por Que Esta Regra Existe

`SSEServerTransport.handlePostMessage(req, res, parsedBody?)` tem dois modos:

1. **`parsedBody` fornecido** → usa direto, nunca toca o stream Node.js → **funciona**
2. **`parsedBody` undefined** → tenta ler o stream com `raw-body` → **falha** se qualquer middleware já consumiu o stream

`express.json()` consome o stream **antes** que `handlePostMessage` possa lê-lo. Resultado: `InternalServerError: stream is not readable`.

`express.text({ type: "application/json" })` lê o stream **uma vez**, salva como string em `req.body`, que então é passada como `parsedBody`.

## Verificação de Conformidade

Antes de commitar qualquer alteração em `src/index.ts`, confirme:

```bash
# Deve retornar zero linhas
grep -n "app.use(express.json\|app.use(bodyParser" src/index.ts

# Deve existir exatamente assim
grep -n "express.text" src/index.ts
grep -n "req.body as string" src/index.ts
```

## Exceções

Nenhuma. Não existe caso de uso que justifique `express.json()` global neste servidor.
Se uma futura rota precisar de JSON no body (ex: webhook de entrada), aplique
`express.json()` **localmente naquela rota específica**, nunca globalmente.
