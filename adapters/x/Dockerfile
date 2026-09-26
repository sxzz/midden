FROM node:24.21.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY adapters/x/package.json adapters/x/package.json
COPY third_party/atmosphere/package.json third_party/atmosphere/package.json
RUN npm ci --ignore-scripts
COPY adapters/x adapters/x
COPY third_party/atmosphere third_party/atmosphere
RUN npm run build && npm prune --omit=dev --ignore-scripts
FROM node:24.21.0-bookworm-slim
WORKDIR /app
COPY --from=build /app/ ./
USER 10001:10001
CMD ["node", "adapters/x/dist/server.js"]
