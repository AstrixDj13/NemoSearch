#!/usr/bin/env bash
# ==============================================================================
# NemoSearch — Nebius Serverless Endpoints & Serverless Jobs Deployment Script
# ==============================================================================
# Usage:
#   ./deploy/nebius_serverless.sh endpoint   # Deploy real-time web app & SSE API
#   ./deploy/nebius_serverless.sh job        # Launch async background research job
# ==============================================================================
set -euo pipefail

MODE="${1:-endpoint}"
IMAGE="${NEBIUS_CONTAINER_IMAGE:-ghcr.io/astrixdj13/nemosearch:latest}"
PLATFORM="${NEBIUS_PLATFORM:-cpu-d3}"
PRESET="${NEBIUS_PRESET:-4vcpu-16gb}"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

: "${NEBIUS_API_KEY:?Please set NEBIUS_API_KEY in your environment or .env}"
SECRET_KEY="${SECRET_KEY:-$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')}"

if [ "$MODE" = "endpoint" ]; then
  echo "==> Deploying NemoSearch on Nebius Serverless Endpoints..."
  echo "    Image:    $IMAGE"
  echo "    Platform: $PLATFORM ($PRESET)"

  SUBNET_ARGS=()
  if [ -n "${NEBIUS_SUBNET_ID:-}" ]; then
    SUBNET_ARGS=(--subnet-id "$NEBIUS_SUBNET_ID")
  fi

  nebius ai endpoint create \
    --name "${NEBIUS_ENDPOINT_NAME:-nemosearch-web}" \
    --image "$IMAGE" \
    --platform "$PLATFORM" \
    --preset "$PRESET" \
    --container-port 8000 \
    --public \
    --env "NEBIUS_API_KEY=${NEBIUS_API_KEY}" \
    --env "NEBIUS_BASE_URL=${NEBIUS_BASE_URL:-https://api.tokenfactory.nebius.com/v1/}" \
    --env "TAVILY_API_KEY=${TAVILY_API_KEY:-}" \
    --env "OPENALEX_API_KEY=${OPENALEX_API_KEY:-}" \
    --env "SECRET_KEY=${SECRET_KEY}" \
    --env "ORCID_CLIENT_ID=${ORCID_CLIENT_ID:-}" \
    --env "ORCID_CLIENT_SECRET=${ORCID_CLIENT_SECRET:-}" \
    "${SUBNET_ARGS[@]}"

  echo "✅ Endpoint created! Check status and public URL with:"
  echo "   nebius ai endpoint list"

elif [ "$MODE" = "job" ]; then
  QUESTION="${2:-Dense vs. mixture-of-experts models for efficient inference}"
  JOB_NAME="nemosearch-job-$(date +%s)"
  echo "==> Launching Asynchronous Nebius Serverless Job: $JOB_NAME"
  echo "    Research Topic: $QUESTION"

  nebius ai job create \
    --name "$JOB_NAME" \
    --image "$IMAGE" \
    --platform "$PLATFORM" \
    --preset "$PRESET" \
    --container-command python \
    --args "-m scripts.nebius_job_worker --question \"$QUESTION\" --focus academic --depth deep --template neurips" \
    --env "NEBIUS_API_KEY=${NEBIUS_API_KEY}" \
    --env "NEBIUS_BASE_URL=${NEBIUS_BASE_URL:-https://api.tokenfactory.nebius.com/v1/}" \
    --env "TAVILY_API_KEY=${TAVILY_API_KEY:-}" \
    --env "OPENALEX_API_KEY=${OPENALEX_API_KEY:-}" \
    --timeout 30m

  echo "✅ Serverless Job submitted! Stream logs with:"
  echo "   JOB_ID=\$(nebius ai job get-by-name --name $JOB_NAME --format jsonpath='{.metadata.id}')"
  echo "   nebius ai logs \"\$JOB_ID\""
else
  echo "Usage: $0 [endpoint|job] [optional_research_question]"
  exit 1
fi

