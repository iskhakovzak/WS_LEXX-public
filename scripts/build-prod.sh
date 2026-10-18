#!/bin/bash
set -e
echo "==> Building frontend..."
BASE_PATH=/ pnpm --filter @workspace/edge-tracker run build

echo "==> Building API server..."
pnpm --filter @workspace/api-server run build

echo "==> Copying frontend to API server public dir..."
mkdir -p artifacts/api-server/dist/public
cp -r artifacts/edge-tracker/dist/public/. artifacts/api-server/dist/public/

echo "==> Production build complete!"
