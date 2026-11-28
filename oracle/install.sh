#!/usr/bin/env bash
# Installs / updates the nifty-guard executor on the Oracle server (Ubuntu 24.04, ARM or x86). Safe to run again.
set -euo pipefail
REPO=https://github.com/sarthakbarik-cmd/nifty-signals
APP=/opt/nifty-signals
STATE=/var/lib/nifty-guard

sudo apt-get update -y
sudo apt-get install -y curl unzip git ca-certificates
sudo timedatectl set-timezone Asia/Kolkata || true

if ! command -v deno >/dev/null 2>&1; then
  curl -fsSL https://deno.land/install.sh | sudo DENO_INSTALL=/usr/local sh -s -- -y
fi
deno --version

id -u nifty-guard >/dev/null 2>&1 || sudo useradd --system --home "$STATE" --create-home --shell /usr/sbin/nologin nifty-guard
sudo mkdir -p "$STATE" && sudo chown nifty-guard:nifty-guard "$STATE" && sudo chmod 700 "$STATE"

if [ -d "$APP/.git" ]; then sudo git -C "$APP" pull --ff-only; else sudo git clone --depth 1 "$REPO" "$APP"; fi

sudo tee /etc/systemd/system/nifty-guard.service >/dev/null <<EOF
[Unit]
Description=nifty-guard executor (Level-2 auto-protect)
After=network-online.target
Wants=network-online.target

[Service]
User=nifty-guard
Environment=NG_STATE=$STATE
Environment=DENO_DIR=$STATE/.deno
ExecStart=/usr/local/bin/deno run --allow-net --allow-env=NG_STATE --allow-read=$STATE --allow-write=$STATE $APP/oracle/executor.ts
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$STATE
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

# hourly self-update from GitHub (restarts only when the code changed)
sudo tee /usr/local/bin/nifty-guard-update >/dev/null <<'EOF'
#!/usr/bin/env bash
set -e
cd /opt/nifty-signals
before=$(git rev-parse HEAD); git pull --ff-only -q; after=$(git rev-parse HEAD)
[ "$before" != "$after" ] && systemctl restart nifty-guard || true
EOF
sudo chmod 755 /usr/local/bin/nifty-guard-update
sudo tee /etc/systemd/system/nifty-guard-update.service >/dev/null <<'EOF'
[Unit]
Description=nifty-guard self-update
[Service]
Type=oneshot
ExecStart=/usr/local/bin/nifty-guard-update
EOF
sudo tee /etc/systemd/system/nifty-guard-update.timer >/dev/null <<'EOF'
[Unit]
Description=nifty-guard hourly self-update
[Timer]
OnCalendar=hourly
RandomizedDelaySec=300
Persistent=true
[Install]
WantedBy=timers.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now nifty-guard.service nifty-guard-update.timer
sleep 8
echo "------------------------------------------------------------"
sudo journalctl -u nifty-guard -n 20 --no-pager | grep -E "PAIRING CODE|waiting|paired|failed" || true
echo "If you see 'PAIRING CODE XXXXXX' above, approve that code on the dashboard (Practice tab)."
