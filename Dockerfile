# syntax=docker/dockerfile:1
FROM node:24-slim AS web
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
COPY pi-extension/package.json pi-extension/
RUN npm ci --workspace web --include-workspace-root=false --no-audit --no-fund
COPY web web
RUN npm --workspace web run build

FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
COPY pi-extension/package.json pi-extension/
RUN npm ci --workspace server --omit=dev --no-audit --no-fund

FROM node:24-slim
ENV NODE_ENV=production \
    NODE_NO_WARNINGS=1 \
    DATA_DIR=/data \
    WEB_DIR=/app/web/dist \
    EXTENSION_DIR=/app/pi-extension \
    PORT=8765
WORKDIR /app/server
COPY --from=deps /app/node_modules /app/node_modules
COPY server/package.json ./
COPY server/src ./src
COPY --from=web /app/web/dist /app/web/dist
COPY pi-extension/index.ts pi-extension/project.ts /app/pi-extension/
USER node
EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:8765/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/index.ts"]
