FROM --platform=$BUILDPLATFORM node:24.21.0-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY scripts/install-pnpm.mjs /tmp/install-pnpm.mjs
RUN node /tmp/install-pnpm.mjs
COPY adapters/x/package.json adapters/x/package.json
COPY third_party/atmosphere/package.json third_party/atmosphere/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts

FROM dependencies AS build
ENV NODE_OPTIONS="--max-old-space-size=384"
COPY adapters/x adapters/x
COPY third_party/atmosphere third_party/atmosphere
RUN pnpm build

FROM node:24.21.0-bookworm-slim AS production-dependencies
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY scripts/install-pnpm.mjs /tmp/install-pnpm.mjs
RUN node /tmp/install-pnpm.mjs
COPY adapters/x/package.json adapters/x/package.json
COPY third_party/atmosphere/package.json third_party/atmosphere/package.json
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

FROM node:24.21.0-bookworm-slim
WORKDIR /app
COPY --from=production-dependencies /app/ ./
COPY --from=build /app/adapters/x/dist/ adapters/x/dist/
COPY --from=build /app/third_party/atmosphere/dist/ third_party/atmosphere/dist/
COPY LICENSE /app/LICENSE
COPY third_party/atmosphere/LICENSE third_party/atmosphere/UPSTREAM.md /app/third_party/atmosphere/
USER 10001:10001
CMD ["node", "adapters/x/dist/server.js"]
