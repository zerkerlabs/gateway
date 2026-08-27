#!/usr/bin/env bash
# The ZMem wheel the Rooms integration suite is proven against (ci.yml) and the
# one deploy/Dockerfile.zmem packages must be the same wheel. If they drift, CI
# is testing against a backend nobody ships and the shipped container is a
# backend nobody tested — neither failure is visible from either file alone.
#
# Run from the repo root. Wired into ci-images.yml.
set -euo pipefail

ci=".github/workflows/ci.yml"
dockerfile="deploy/Dockerfile.zmem"

# The CI pin is one URL: .../v<version>/zerker_memory-<version>-py3-none-any.whl#sha256=<digest>
ci_version="$(grep -oE 'zmem/releases/download/v[0-9]+\.[0-9]+\.[0-9]+' "$ci" | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || true)"
ci_sha="$(grep -oE 'sha256=[0-9a-f]{64}' "$ci" | head -1 | cut -d= -f2 || true)"

# The Dockerfile pin is two build args.
df_version="$(grep -oE '^ARG ZMEM_VERSION=[0-9]+\.[0-9]+\.[0-9]+' "$dockerfile" | cut -d= -f2 || true)"
df_sha="$(grep -oE '^ARG ZMEM_SHA256=[0-9a-f]{64}' "$dockerfile" | cut -d= -f2 || true)"

fail=0
for pair in "version:$ci_version:$df_version" "sha256:$ci_sha:$df_sha"; do
	field="${pair%%:*}"; rest="${pair#*:}"; ci_val="${rest%%:*}"; df_val="${rest#*:}"
	if [ -z "$ci_val" ] || [ -z "$df_val" ]; then
		echo "check-zmem-pin: could not read the $field pin (ci='$ci_val' dockerfile='$df_val')" >&2
		fail=1
	elif [ "$ci_val" != "$df_val" ]; then
		echo "check-zmem-pin: $field differs — $ci says '$ci_val', $dockerfile says '$df_val'" >&2
		fail=1
	fi
done

if [ "$fail" -ne 0 ]; then
	echo "check-zmem-pin: move both pins together, or the shipped sidecar is untested." >&2
	exit 1
fi

echo "check-zmem-pin: ok (zmem $ci_version, sha256 ${ci_sha:0:12}…)"
