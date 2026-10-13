#!/usr/bin/env bash
# Non-destructive dependency audit for EagleSong WebMiner.
set -uo pipefail

if [[ -t 1 ]]; then
  green=$'\033[32m'; yellow=$'\033[33m'; red=$'\033[31m'; reset=$'\033[0m'
else
  green=''; yellow=''; red=''; reset=''
fi
missing=0
outdated=0
ok() { printf '  %s✓%s %s\n' "$green" "$reset" "$1"; }
miss() { printf '  %s✗%s %s — missing\n' "$red" "$reset" "$1"; missing=$((missing + 1)); }
old() { printf '  %s!%s %s — %s\n' "$yellow" "$reset" "$1" "$2"; outdated=$((outdated + 1)); }
optional() { printf '  - %s (optional)\n' "$1"; }

echo 'Environment check for EagleSong WebMiner'
echo 'Core dependencies:'
if command -v node >/dev/null 2>&1; then
  node_major=$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || printf 0)
  if [[ "$node_major" -ge 20 ]]; then ok "Node.js $(node --version)"; else old "Node.js $(node --version)" 'need >= 20'; missing=$((missing + 1)); fi
else miss 'Node.js >= 20'; fi
if command -v npm >/dev/null 2>&1; then ok "npm $(npm --version)"; else miss npm; fi

check_node_package() {
  local pkg="$1" minimum="$2" version major
  if ! command -v node >/dev/null 2>&1; then miss "$pkg"; return; fi
  version=$(node -e 'try { console.log(require(process.argv[1] + "/package.json").version) } catch {}' "$pkg" 2>/dev/null)
  if [[ -z "$version" ]]; then miss "$pkg"; return; fi
  major=${version%%.*}
  if [[ "$major" -lt "$minimum" ]]; then old "$pkg $version" "need major >= $minimum"; else ok "$pkg $version"; fi
}
check_node_package ws 8
check_node_package esbuild 0

echo
echo 'Optional test and release tools:'
if command -v node >/dev/null 2>&1 && node -e 'require.resolve("playwright")' >/dev/null 2>&1; then ok 'Playwright package'; else optional 'Playwright package for browser tests'; fi
for tool in git gh ckb; do
  if command -v "$tool" >/dev/null 2>&1; then ok "$tool"; else optional "$tool"; fi
done

echo
echo 'System:'
df -h . 2>/dev/null | awk 'NR==2 {print "  free disk: " $4}'
echo
if [[ "$missing" -gt 0 ]]; then
  printf '%s%d missing, %d outdated.%s See README.md.\n' "$red" "$missing" "$outdated" "$reset"
  exit 1
fi
if [[ "$outdated" -gt 0 ]]; then
  printf '%s%d outdated.%s Build dependencies are present.\n' "$yellow" "$outdated" "$reset"
  exit 0
fi
printf '%sAll checks passed.%s You can build.\n' "$green" "$reset"
