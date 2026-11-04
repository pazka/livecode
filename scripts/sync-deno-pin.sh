#!/usr/bin/env bash
# Carry the Deno version of the Dockerfile's build-stage base image (the line Dependabot bumps) to every
# other pin: the denort ADD (URL + --checksum), the Deno installs in ci/release/screenshot workflows
# (URL + sha256 + step name) and DEPLOY.md. Checksums come from Deno's own release assets (*.sha256sum).
# Then run `deno task test`: tests/pins_test.ts must pass.
#
# Usage: bash scripts/sync-deno-pin.sh
set -euo pipefail
cd "$(dirname "$0")/.."

new="$(sed -nE 's/^FROM denoland\/deno:debian-([0-9]+\.[0-9]+\.[0-9]+)@sha256:.*/\1/p' Dockerfile)"
old="$(sed -nE 's/.*releases\/download\/v([0-9]+\.[0-9]+\.[0-9]+)\/denort-.*/\1/p' Dockerfile)"
[ -n "$new" ] && [ -n "$old" ] || { echo "cannot parse the Deno version from Dockerfile" >&2; exit 1; }
[ "$new" != "$old" ] || { echo "already in sync at Deno $new"; exit 0; }

rel="https://github.com/denoland/deno/releases/download/v$new"
sum() { curl -fsSL "$rel/$1.sha256sum" | awk '{print $1}' | grep -E '^[0-9a-f]{64}$'; }
deno_sum="$(sum deno-x86_64-unknown-linux-gnu.zip)"
denort_sum="$(sum denort-x86_64-unknown-linux-gnu.zip)"
old_deno_sum="$(sed -nE 's/.*echo "([0-9a-f]{64})  \/tmp\/deno\.zip".*/\1/p' .github/workflows/ci.yml | head -n1)"
old_denort_sum="$(sed -nE 's/.*--checksum=sha256:([0-9a-f]{64}).*/\1/p' Dockerfile)"
[ -n "$old_deno_sum" ] && [ -n "$old_denort_sum" ] || { echo "cannot find the current checksums" >&2; exit 1; }

o="${old//./\\.}"
sed -i \
  -e "s/releases\/download\/v$o\//releases\/download\/v$new\//g" \
  -e "s/Deno $o/Deno $new/g" \
  -e "s/$old_deno_sum/$deno_sum/g" \
  -e "s/$old_denort_sum/$denort_sum/g" \
  Dockerfile .github/workflows/ci.yml .github/workflows/release.yml .github/workflows/bootstrap.yml DEPLOY.md

echo "Deno $old -> $new"
echo "  deno.zip   $deno_sum"
echo "  denort.zip $denort_sum"
