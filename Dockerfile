FROM --platform=$BUILDPLATFORM node:24.21.0-bookworm-slim AS web-build
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY scripts/install-pnpm.mjs /tmp/install-pnpm.mjs
RUN node /tmp/install-pnpm.mjs
COPY web/package.json web/package.json
COPY adapters/x/package.json adapters/x/package.json
COPY third_party/atmosphere/package.json third_party/atmosphere/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY web web
RUN pnpm --filter @midden/web build

FROM --platform=$BUILDPLATFORM golang:1.27.1-alpine3.23 AS build
ARG TARGETOS
ARG TARGETARCH
ARG BUILD_PROCS=2
ARG VCS_REF
ENV GOMAXPROCS=${BUILD_PROCS} GOGC=50
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN --mount=type=cache,target=/root/.cache/go-build CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -p 1 -trimpath -ldflags "-X monitor/internal/buildinfo.Revision=${VCS_REF}" -o /out/core ./cmd/core && \
    CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -p 1 -trimpath -o /out/monitorctl ./cmd/monitorctl
FROM alpine:3.23.3
RUN apk add --no-cache ca-certificates ffmpeg && addgroup -g 10001 monitor && adduser -D -H -u 10001 -G monitor monitor
COPY --from=build /out/ /usr/local/bin/
COPY LICENSE /usr/share/licenses/midden/LICENSE
COPY --from=web-build /src/web/dist /opt/midden/web
ENV WEB_DIST=/opt/midden/web
USER 10001:10001
ENTRYPOINT ["core"]
