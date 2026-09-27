FROM --platform=$BUILDPLATFORM node:24.21.0-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY adapters/x/package.json adapters/x/package.json
COPY third_party/atmosphere/package.json third_party/atmosphere/package.json
RUN npm ci --ignore-scripts --no-audit --no-fund

FROM dependencies AS build
ENV NODE_OPTIONS="--max-old-space-size=384"
COPY adapters/x adapters/x
COPY third_party/atmosphere third_party/atmosphere
RUN node node_modules/typescript/bin/tsc -p third_party/atmosphere/tsconfig.json && \
    node node_modules/typescript/bin/tsc -p adapters/x/tsconfig.json

FROM node:24.21.0-bookworm-slim AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY adapters/x/package.json adapters/x/package.json
COPY third_party/atmosphere/package.json third_party/atmosphere/package.json
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24.21.0-bookworm-slim
WORKDIR /app
COPY --from=production-dependencies /app/ ./
COPY --from=build /app/adapters/x/dist/ adapters/x/dist/
COPY --from=build /app/third_party/atmosphere/dist/ third_party/atmosphere/dist/
USER 10001:10001
CMD ["node", "adapters/x/dist/server.js"]
