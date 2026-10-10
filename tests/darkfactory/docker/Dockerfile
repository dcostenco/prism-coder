FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts --omit=dev
COPY dist ./dist
COPY tests/darkfactory/docker/runner.mjs ./runner.mjs
USER 1000:1000
ENTRYPOINT ["node", "/app/runner.mjs"]
