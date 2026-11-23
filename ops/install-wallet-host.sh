#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this installer with sudo from the SatoshiCore web repository." >&2
  exit 1
fi

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
config_dir=/usr/local/etc/satoshicore
main_config="$config_dir/Caddyfile.all"
wallet_config="$config_dir/Caddyfile.wallet"
launchd_label=system/com.satoshicore.caddy-standard-ports
timestamp=$(date +%Y%m%d-%H%M%S)
main_backup="$main_config.bak-wallet-$timestamp"
wallet_backup="$wallet_config.bak-wallet-$timestamp"
had_wallet_config=0

if [ ! -f "$main_config" ] || [ ! -f "$repo_root/ops/Caddyfile.wallet" ]; then
  echo "Expected Caddy configuration files are missing; nothing changed." >&2
  exit 1
fi

cp -p "$main_config" "$main_backup"
if [ -f "$wallet_config" ]; then
  cp -p "$wallet_config" "$wallet_backup"
  had_wallet_config=1
fi

restore_config() {
  cp -p "$main_backup" "$main_config"
  if [ "$had_wallet_config" -eq 1 ]; then
    cp -p "$wallet_backup" "$wallet_config"
  else
    rm -f "$wallet_config"
  fi
}

install -o root -g wheel -m 644 "$repo_root/ops/Caddyfile.wallet" "$wallet_config"
if ! grep -Fqx 'import Caddyfile.wallet' "$main_config"; then
  printf '\nimport Caddyfile.wallet\n' >> "$main_config"
fi

if ! env \
  NSAT_DOMAIN=gateway.satoshicore.org \
  NSAT_HTTP_PORT=80 \
  NSAT_HTTPS_PORT=443 \
  NSAT_WEB_DOMAIN=satoshicore.org \
  NSAT_WEB_ROOT=/Users/migssa-ngakhaonu/nsat-ops/satoshicore-webroot \
  /opt/homebrew/bin/caddy validate --config "$main_config" --adapter caddyfile; then
  echo "Caddy validation failed; restoring the previous configuration." >&2
  restore_config
  exit 1
fi

if ! launchctl kickstart -k "$launchd_label"; then
  echo "Caddy restart failed; restoring the previous configuration." >&2
  restore_config
  launchctl kickstart -k "$launchd_label" || true
  exit 1
fi

echo "Wallet host configured. Static files are in /Users/migssa-ngakhaonu/nsat-ops/wallet-webroot."
echo "Caddy backup: $main_backup"
echo "Check https://wallet.satoshicore.org/ and /build-manifest.json after certificate provisioning."
