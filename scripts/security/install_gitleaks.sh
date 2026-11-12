#!/usr/bin/env bash
# Pinned upstream release; checksum verified before extracting/executing.
set -euo pipefail
version=8.30.1
checksum=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
if [[ "$(uname -s)" != Linux || "$(uname -m)" != x86_64 ]]; then
  echo 'This installer supports Linux x86_64. Install Gitleaks 8.30.1 from its official release for other platforms.' >&2
  exit 2
fi
destination="${1:?Usage: bash scripts/security/install_gitleaks.sh DESTINATION}"
mkdir -p "$destination"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  --connect-timeout 15 --max-time 120 \
  "https://github.com/gitleaks/gitleaks/releases/download/v${version}/gitleaks_${version}_linux_x64.tar.gz" \
  --output "$tmp/gitleaks.tar.gz"
printf '%s  %s\n' "$checksum" "$tmp/gitleaks.tar.gz" | sha256sum --check --status
tar -xzf "$tmp/gitleaks.tar.gz" -C "$tmp" gitleaks
install -m 0755 "$tmp/gitleaks" "$destination/gitleaks"
"$destination/gitleaks" version
