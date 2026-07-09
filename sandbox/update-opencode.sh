#!/usr/bin/env bash
# Build, verify, and publish the sandbox image for a given opencode version.
#
#   sandbox/update-opencode.sh                 # latest opencode release
#   sandbox/update-opencode.sh 1.18.2          # specific version
#   sandbox/update-opencode.sh 1.18.2 --deploy # ...and point the cluster at it
#
# The new version is only pushed if the smoke test passes (it exercises the
# exact opencode server API surface the runner depends on). Images are tagged
# with the opencode version and :latest, so rolling back is
# `--deploy`ing a previous version tag.
#
# Requires push access to the registry (docker login container.cs.vt.edu) and,
# for --deploy, KUBECONFIG access to the vtlib namespace.
set -euo pipefail

DIR=$(cd "$(dirname "$0")" && pwd)
ROOT=$(dirname "$DIR")

VERSION=${1:-latest}
DEPLOY=${2:-}

# shellcheck disable=SC1091
set -a; . "$ROOT/.env"; set +a
REPO=${SANDBOX_CONTAINER_IMAGE%:*}

if [ "$VERSION" = "latest" ]; then
  VERSION=$(npm view opencode-ai version)
  echo "latest opencode release: $VERSION"
fi

VERSIONED_IMAGE="$REPO:$VERSION"
LATEST_IMAGE="$REPO:latest"

# Stage the agent's initial working directory (see sandbox/redeploy.sh).
rsync -a --delete "$ROOT/opencode-master-config/home/" "$DIR/home/"

echo "=== building $VERSIONED_IMAGE"
docker build --build-arg OPENCODE_VERSION="$VERSION" \
  -t "$VERSIONED_IMAGE" -t "$LATEST_IMAGE" "$DIR"

echo "=== smoke testing"
"$DIR/test/smoke.sh" "$VERSIONED_IMAGE"

echo "=== pushing"
docker push "$VERSIONED_IMAGE"
docker push "$LATEST_IMAGE"

if [ "$DEPLOY" = "--deploy" ]; then
  echo "=== deploying to cluster"
  # .env sets a c2c-relative KUBECONFIG; fall back to the repo copy.
  if [ ! -f "${KUBECONFIG:-}" ]; then
    KUBECONFIG="$ROOT/endeavour.yaml"
  fi
  export KUBECONFIG=$(realpath "$KUBECONFIG")
  kubectl -n "${K8S_NAMESPACE:-vtlib}" patch secret c2c-env --type merge \
    -p "{\"stringData\":{\"SANDBOX_CONTAINER_IMAGE\":\"$VERSIONED_IMAGE\"}}"
  kubectl -n "${K8S_NAMESPACE:-vtlib}" rollout restart deploy/c2c
  kubectl -n "${K8S_NAMESPACE:-vtlib}" rollout status deploy/c2c --timeout=180s
  echo "cluster now launches agents from $VERSIONED_IMAGE"
else
  echo
  echo "Not deployed. To point the cluster at this version:"
  echo "  sandbox/update-opencode.sh $VERSION --deploy"
fi
