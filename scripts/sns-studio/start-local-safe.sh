#!/bin/sh
set -eu

TEMPORAL_WAIT_SECONDS="${SNS_STUDIO_TEMPORAL_WAIT_SECONDS:-300}"

echo "SNS Studio safe container startup: preparing nginx and uploads"
nginx
mkdir -p /uploads/sns-studio
chown 10002:10002 /uploads/sns-studio

echo "SNS Studio safe container startup: waiting for temporal:7233"
deadline=$(( $(date +%s) + TEMPORAL_WAIT_SECONDS ))
while :; do
  if node -e 'const net=require("node:net");const socket=net.createConnection({host:"temporal",port:7233});const finish=ok=>{socket.destroy();process.exit(ok?0:1)};socket.setTimeout(1000,()=>finish(false));socket.once("connect",()=>finish(true));socket.once("error",()=>finish(false));' >/dev/null 2>&1; then
    break
  fi

  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "SNS Studio startup failed: temporal:7233 was not ready within ${TEMPORAL_WAIT_SECONDS}s" >&2
    exit 1
  fi
  sleep 3
done

if [ ! -f /app/.env ]; then
  echo "SNS Studio startup failed: /app/.env is missing" >&2
  exit 1
fi

if [ ! -f /app/apps/backend/dist/apps/backend/src/main.js ]; then
  echo "SNS Studio startup failed: backend entrypoint is missing" >&2
  exit 1
fi

for app in backend frontend orchestrator; do
  pm2 delete "$app" >/dev/null 2>&1 || true
done

echo "SNS Studio safe container startup: starting backend directly with Node under PM2"
pm2 start /app/apps/backend/dist/apps/backend/src/main.js \
  --name backend \
  --cwd /app/apps/backend \
  --interpreter node \
  --node-args="--env-file=/app/.env --experimental-require-module" \
  >/dev/null

echo "SNS Studio safe container startup: starting existing frontend and orchestrator PM2 scripts"
pnpm --filter ./apps/frontend run pm2 >/dev/null
pnpm --filter ./apps/orchestrator run pm2 >/dev/null

stop_apps() {
  for app in backend frontend orchestrator; do
    pm2 delete "$app" >/dev/null 2>&1 || true
  done
  nginx -s quit >/dev/null 2>&1 || true
}
trap stop_apps INT TERM

echo "SNS Studio safe container startup: services handed to PM2"
while :; do
  sleep 3600 &
  wait "$!"
done