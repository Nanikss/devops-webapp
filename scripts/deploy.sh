#!/usr/bin/env bash
# Deploy the feature-flags service with kustomize + kubectl.
#
#   scripts/deploy.sh <overlay> <image-tag>   apply k8s/overlays/<overlay> with that image tag
#   scripts/deploy.sh <overlay> --rollback    roll the Deployment back to its previous revision
#
# Environment:
#   IMAGE            image repository (default ghcr.io/nanikss/devops-webapp)
#   ROLLOUT_TIMEOUT  how long to wait for the rollout (default 180s)
#   AUTO_ROLLBACK    roll back automatically if the rollout fails (default true)
#
# Requires kubectl and kustomize, and uses the current kubectl context.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_IMAGE="ghcr.io/nanikss/devops-webapp"   # image name referenced in k8s/base
IMAGE="${IMAGE:-$BASE_IMAGE}"
ROLLOUT_TIMEOUT="${ROLLOUT_TIMEOUT:-180s}"
AUTO_ROLLBACK="${AUTO_ROLLBACK:-true}"
DEPLOYMENT="deployment/feature-flags"

log() { printf '==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
usage() { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
require() { command -v "$1" >/dev/null 2>&1 || die "$1 is not installed"; }

[ $# -eq 2 ] || usage
overlay="$1"
target="$2"
overlay_dir="$ROOT/k8s/overlays/$overlay"
[ -f "$overlay_dir/kustomization.yaml" ] || die "unknown overlay '$overlay' (expected k8s/overlays/$overlay)"

namespace="$(awk '/^namespace:/ { print $2 }' "$overlay_dir/kustomization.yaml" | tr -d '\r')"
[ -n "$namespace" ] || die "overlay '$overlay' does not set a namespace"

require kubectl
log "context: $(kubectl config current-context), namespace: $namespace"

wait_for_rollout() {
  kubectl -n "$namespace" rollout status "$DEPLOYMENT" --timeout="$ROLLOUT_TIMEOUT"
}

if [ "$target" = "--rollback" ]; then
  log "rolling back $DEPLOYMENT"
  kubectl -n "$namespace" rollout undo "$DEPLOYMENT"
  wait_for_rollout
  kubectl -n "$namespace" rollout history "$DEPLOYMENT" | tail -n 3
  exit 0
fi

tag="$target"
[[ "$tag" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || die "invalid image tag '$tag'"
if [ "$overlay" = "prod" ] && [ "$tag" = "latest" ]; then
  die "refusing to deploy :latest to prod; use an immutable tag such as the commit SHA"
fi
require kustomize

# Edit a throwaway copy so the image tag never ends up as a diff in the repo.
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp -R "$ROOT/k8s" "$work/k8s"
(cd "$work/k8s/overlays/$overlay" && kustomize edit set image "$BASE_IMAGE=$IMAGE:$tag")

log "applying overlay '$overlay' with image $IMAGE:$tag"
kubectl apply -k "$work/k8s/overlays/$overlay"

log "waiting for rollout (timeout $ROLLOUT_TIMEOUT)"
if ! wait_for_rollout; then
  log "rollout did not finish; current pods:"
  kubectl -n "$namespace" get pods -l app.kubernetes.io/name=feature-flags -o wide || true
  if [ "$AUTO_ROLLBACK" = "true" ]; then
    log "rolling back to the previous revision"
    kubectl -n "$namespace" rollout undo "$DEPLOYMENT" && wait_for_rollout || true
  fi
  die "deploy of $IMAGE:$tag to $overlay failed"
fi

log "deployed $IMAGE:$tag to $overlay"
