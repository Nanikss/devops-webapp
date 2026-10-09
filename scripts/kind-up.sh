#!/usr/bin/env bash
# Local demo on kind: create a cluster, build and load the image, apply the dev
# overlay and port-forward the Service to http://localhost:${LOCAL_PORT:-8080}.
#
# Requires docker, kind and kubectl. Re-running it rebuilds and redeploys.
# Clean up with: kind delete cluster --name flags
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLUSTER="${KIND_CLUSTER:-flags}"
IMAGE="ghcr.io/nanikss/devops-webapp:dev"   # the tag the dev overlay expects
NAMESPACE="flags-dev"
LOCAL_PORT="${LOCAL_PORT:-8080}"

log() { printf '==> %s\n' "$*"; }
for cmd in docker kind kubectl; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "error: $cmd is not installed" >&2; exit 1; }
done

# Always target the kind cluster explicitly, never whatever context is current.
k() { kubectl --context "kind-$CLUSTER" "$@"; }

if ! kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  log "creating kind cluster '$CLUSTER'"
  kind create cluster --name "$CLUSTER" --wait 120s
fi

log "building $IMAGE"
docker build --build-arg APP_VERSION=dev-local -t "$IMAGE" "$ROOT"

log "loading image into the cluster"
kind load docker-image "$IMAGE" --name "$CLUSTER"

existed=false
k -n "$NAMESPACE" get deployment feature-flags >/dev/null 2>&1 && existed=true

log "applying k8s/overlays/dev"
k apply -k "$ROOT/k8s/overlays/dev"

# The tag "dev" is reused between builds, so the pod template doesn't change on a
# rebuild. Restart explicitly so pods pick up the freshly loaded image.
if [ "$existed" = "true" ]; then
  k -n "$NAMESPACE" rollout restart deployment/feature-flags
fi
k -n "$NAMESPACE" rollout status deployment/feature-flags --timeout=120s

log "port-forwarding http://localhost:$LOCAL_PORT (Ctrl+C to stop)"
log "try: curl localhost:$LOCAL_PORT/api/flags"
k -n "$NAMESPACE" port-forward svc/feature-flags "$LOCAL_PORT:80"
