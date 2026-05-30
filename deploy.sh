#!/usr/bin/env bash
#
# deploy.sh — Deploy do OpLab MCP Server no Google Cloud Run em UM comando.
#
# Faz, em sequência:
#   0. Garante que o repositório do Artifact Registry existe (cria se faltar)
#   1. Build + push da imagem (via Cloud Build)
#   2. Deploy no Cloud Run com TODOS os parâmetros obrigatórios (ver CLAUDE.md)
#   3. Health check — confirma o número de ferramentas no ar
#
# Uso:
#   ./deploy.sh
#   PROJECT_ID=oplab-mcp-server ./deploy.sh
#
# Variáveis (todas opcionais — têm defaults sensatos):
#   PROJECT_ID  projeto GCP        (default: projeto ativo do gcloud)
#   REGION      região Cloud Run   (default: us-east1 — NÃO mude, ver CLAUDE.md)
#   REPO        repo Artifact Reg. (default: oplab-mcp)
#   SERVICE     serviço Cloud Run  (default: oplab-mcp-server)
#
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${REGION:-us-east1}"
REPO="${REPO:-oplab-mcp}"
SERVICE="${SERVICE:-oplab-mcp-server}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/server:latest"

if [[ -z "${PROJECT_ID}" || "${PROJECT_ID}" == "(unset)" ]]; then
  echo "✗ PROJECT_ID vazio. Rode:  gcloud config set project SEU_PROJECT_ID" >&2
  exit 1
fi

echo "▶ Projeto:  ${PROJECT_ID}"
echo "▶ Região:   ${REGION}"
echo "▶ Serviço:  ${SERVICE}"
echo "▶ Imagem:   ${IMAGE}"
echo

# 0. Artifact Registry — cria o repositório se ainda não existir
if ! gcloud artifacts repositories describe "${REPO}" \
      --location="${REGION}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  echo "▶ Criando repositório Artifact Registry '${REPO}'..."
  gcloud artifacts repositories create "${REPO}" \
    --repository-format=docker \
    --location="${REGION}" \
    --project="${PROJECT_ID}" \
    --description="OpLab MCP server images"
fi

# 1. Build + push (Cloud Build usa o Dockerfile da raiz)
echo "▶ Build + push da imagem..."
gcloud builds submit --tag "${IMAGE}" --project="${PROJECT_ID}"

# 2. Deploy no Cloud Run — parâmetros obrigatórios para SSE estável
echo "▶ Deploy no Cloud Run..."
gcloud run deploy "${SERVICE}" \
  --image "${IMAGE}" \
  --region "${REGION}" \
  --platform managed \
  --allow-unauthenticated \
  --set-secrets OPLAB_ACCESS_TOKEN=OPLAB_ACCESS_TOKEN:latest \
  --port 8080 \
  --no-cpu-throttling \
  --timeout=3600 \
  --min-instances=1 \
  --max-instances=3 \
  --project="${PROJECT_ID}"

# 3. Health check
URL="$(gcloud run services describe "${SERVICE}" \
        --region "${REGION}" --project="${PROJECT_ID}" \
        --format='value(status.url)')"
echo
echo "▶ Health check: ${URL}/health"
curl -fsS "${URL}/health" && echo
echo
echo "✓ Deploy concluído. Confira \"tools\":31 acima."
echo "  Lembre de reconectar o conector OpLab no Claude para limpar o cache da lista de ferramentas."
