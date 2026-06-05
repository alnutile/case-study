# syntax=docker/dockerfile:1

# ---- build stage ----------------------------------------------------------
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage --------------------------------------------------------
FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Audit DB lives on a volume mounted inside Korral's tenancy.
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME ["/app/data"]

# Note: no MCP_HTTP_PORT here — the app binds $PORT when the platform injects it
# (Railway/Cloud Run), else falls back to 8080.
ENV MCP_TRANSPORT=http \
    MCP_HTTP_HOST=0.0.0.0 \
    AUDIT_DB_PATH=/app/data/audit.db \
    STORELINK_BASE_URL=http://storelink.internal \
    LOG_LEVEL=info

EXPOSE 8080
USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||process.env.MCP_HTTP_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
