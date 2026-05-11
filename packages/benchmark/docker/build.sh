#!/usr/bin/env bash
# Build the sandbox images.
#
# Image taxonomy:
#   ctx7-bench:py37-base, py39-base, py310-base       — base Python images,
#                                                       used by oneshot/agentic modes
#   ctx7-bench:py37, py39, py310                      — alias of -base for the
#                                                       existing modes
#   ctx7-bench:py310-cc                               — base + Node + Claude Code,
#                                                       used by the `claudecode` mode
#                                                       (3.10 only in v0)

set -euo pipefail

PREFIX="${CTX7_BENCH_IMAGE_PREFIX:-ctx7-bench}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

build_base() {
  local py="$1"
  local osv="$2"
  local short="${py//./}"
  local tag_base="${PREFIX}:py${short}-base"
  local tag_alias="${PREFIX}:py${short}"
  echo "==> building ${tag_base} (python ${py}, ${osv})"
  docker build \
    --build-arg "PY_VERSION=${py}" \
    --build-arg "OS_VARIANT=${osv}" \
    -t "${tag_base}" \
    -f "${HERE}/Dockerfile" \
    "${HERE}"
  docker tag "${tag_base}" "${tag_alias}"
}

build_cc() {
  local py="$1"
  local short="${py//./}"
  local tag="${PREFIX}:py${short}-cc"
  echo "==> building ${tag} (claude code on top of py${short}-base)"
  docker build \
    --build-arg "PY_VERSION=${py}" \
    --build-arg "IMAGE_PREFIX=${PREFIX}" \
    -t "${tag}" \
    -f "${HERE}/Dockerfile.claudecode" \
    "${HERE}"
}

build_base "3.10" "slim-bookworm"
build_base "3.9"  "slim-bullseye"
build_base "3.7"  "slim-buster"

build_cc "3.10"

echo "==> done"
