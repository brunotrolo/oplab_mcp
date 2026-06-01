# Regra: Infraestrutura GCP — Parâmetros Obrigatórios

**Escopo:** ativada ao modificar `Dockerfile`, `cloudbuild.yaml`, ou executar comandos `gcloud`.

---

## Região: Sempre `us-east1`

```bash
# ✅ CORRETO
gcloud run deploy ... --region us-east1

# ❌ PROIBIDO — latência transcontinental quebra o handshake SSE
gcloud run deploy ... --region southamerica-east1
```

**Motivo:** Os servidores da Anthropic (Claude Web/Mobile) ficam nos EUA. ~200 ms de
latência por mensagem SSE ultrapassa o timeout de handshake do cliente MCP.

---

## Parâmetros Obrigatórios no `gcloud run deploy`

Todos os deploys devem incluir **obrigatoriamente**:

```bash
--no-cpu-throttling   # sem isso, Cloud Run suspende CPU de SSE "ociosas"
--timeout=3600        # padrão é 300s; SSE ativa por 5+ min seria derrubada
--set-secrets OPLAB_ACCESS_TOKEN=OPLAB_ACCESS_TOKEN:latest  # nunca --set-env-vars
```

Template completo:
```bash
gcloud run deploy oplab-mcp-server \
  --image us-east1-docker.pkg.dev/PROJECT/oplab-mcp/server:latest \
  --region us-east1 \
  --platform managed \
  --allow-unauthenticated \
  --set-secrets OPLAB_ACCESS_TOKEN=OPLAB_ACCESS_TOKEN:latest \
  --port 8080 \
  --no-cpu-throttling \
  --timeout=3600 \
  --min-instances=1 \
  --max-instances=3
```

---

## Token: Sempre Secret Manager, Nunca `--set-env-vars`

O token da OpLab contém `/`, `=` e `-`. Passado via `--set-env-vars`, pode ser
corrompido por encoding do shell. O Secret Manager injeta o valor bruto sem transformação.

```bash
# ❌ PROIBIDO
--set-env-vars OPLAB_ACCESS_TOKEN="z2Kw..."

# ✅ CORRETO
--set-secrets OPLAB_ACCESS_TOKEN=OPLAB_ACCESS_TOKEN:latest
```

---

## Dockerfile: Manter Multi-Stage

O `Dockerfile` usa dois estágios para imagem mínima. Não colapse em stage único.

```dockerfile
# Stage 1: builder — compila TypeScript
FROM node:20-slim AS builder
# ...npm ci + tsc...

# Stage 2: runtime — só dist/ + node_modules de produção
FROM node:20-slim AS runtime
# ...COPY --from=builder...
```

---

## Health Check

O Cloud Run usa `GET /health` para verificar se a instância está viva.
Esta rota **não pode ser removida** do `src/index.ts`.

Resposta esperada: `{"status":"ok","tools":35,...}`
