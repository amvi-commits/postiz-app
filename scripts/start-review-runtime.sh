#!/bin/sh
set -e

echo "[review-runtime] Starting nginx..."
nginx

echo "[review-runtime] Creating upload directories..."
mkdir -p /uploads/sns-studio

echo "[review-runtime] Running prisma db push..."
pnpm dlx prisma@6.5.0 db push --schema ./libraries/nestjs-libraries/src/database/prisma/schema.prisma

echo "[review-runtime] Running review database seed..."
node /app/scripts/seed-review.cjs

echo "[review-runtime] Starting backend under PM2..."
pm2 start /app/apps/backend/dist/apps/backend/src/main.js \
  --name backend \
  --cwd /app/apps/backend \
  --interpreter node \
  --node-args="--experimental-require-module"

echo "[review-runtime] Starting frontend under PM2..."
pnpm --filter ./apps/frontend run pm2

echo "[review-runtime] Review runtime services active."
while :; do
  sleep 3600 &
  wait "$!"
done
