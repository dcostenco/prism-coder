FROM node:22-bookworm-slim
COPY tests/darkfactory/docker/model-proxy.mjs /model-proxy.mjs
USER 1000:1000
ENTRYPOINT ["node", "/model-proxy.mjs"]
