#!/usr/bin/env bash
# Builds (and optionally pushes) every image this project publishes, with one
# shared version tag and consistent multi-arch (amd64+arm64) coverage for
# all of them -- use this instead of ad-hoc `docker build`/`buildx build`
# commands, so images don't end up on mismatched versions or missing arm64
# (that gap is exactly what broke wingene-82, an arm64 box, until it got
# fixed after the fact).
#
# Usage:
#   VERSION=v1.1.0 ./deploy/build-images.sh            # build only, local
#   VERSION=v1.1.0 ./deploy/build-images.sh --push      # build + push to GHCR
#
# Requires `docker login ghcr.io` first if using --push, and QEMU binfmt
# registered for cross-arch builds (one-time, per host):
#   docker run --privileged --rm tonistiigi/binfmt --install all
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

VERSION="${VERSION:?set VERSION, e.g. VERSION=v1.1.0}"
IMG_BASE="ghcr.io/richard880502/gpu-dashboard"
PLATFORMS="linux/amd64,linux/arm64"

PUSH_FLAG=""
if [[ "${1:-}" == "--push" ]]; then
    PUSH_FLAG="--push"
elif [[ "${1:-}" != "" ]]; then
    echo "unknown argument: $1 (only --push is accepted)" >&2
    exit 1
fi
# Without --push: buildx can't --load a multi-platform result into the local
# daemon (there's no single "the" image to load), so this just validates
# each Dockerfile builds cleanly for both platforms without loading/pushing
# anything -- pass $PUSH_FLAG empty and let buildx cache the result.

build() {
    local name="$1" context="$2" dockerfile="$3"
    echo "=== $name ==="
    docker buildx build --platform "$PLATFORMS" \
        -t "${IMG_BASE}/${name}:${VERSION}" -t "${IMG_BASE}/${name}:latest" \
        -f "$dockerfile" $PUSH_FLAG "$context"
}

build nvitop-exporter      deploy/docker/nvitop-exporter      deploy/docker/nvitop-exporter/Dockerfile
build gpu-process-exporter deploy/docker/gpu-process-exporter deploy/docker/gpu-process-exporter/Dockerfile

echo
echo "Built (and $( [[ "$PUSH_FLAG" == "--push" ]] && echo "pushed" || echo "validated, not pushed" )) both images at version $VERSION."
