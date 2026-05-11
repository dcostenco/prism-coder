FROM node:20-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY tsconfig.json ./
RUN npm ci
COPY src/ ./src/
RUN npm run build

FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --production

COPY --from=builder /app/dist ./dist
COPY smithery-bridge.mjs ./

# Railway: HTTP via smithery-bridge (exposes /healthz + MCP over supergateway)
# Local/Claude Desktop: stdio via dist/server.js
# Override CMD at runtime or set via railway.json startCommand
EXPOSE 8000
CMD ["node", "smithery-bridge.mjs"]
