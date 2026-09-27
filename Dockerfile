FROM --platform=$BUILDPLATFORM golang:1.27.1-alpine3.23 AS build
ARG TARGETOS
ARG TARGETARCH
ARG BUILD_PROCS=2
ENV GOMAXPROCS=${BUILD_PROCS} GOGC=50
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN --mount=type=cache,target=/root/.cache/go-build CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -p 1 -trimpath -o /out/core ./cmd/core && \
    CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -p 1 -trimpath -o /out/monitorctl ./cmd/monitorctl
FROM alpine:3.23.3
RUN apk add --no-cache ca-certificates ffmpeg && addgroup -g 10001 monitor && adduser -D -H -u 10001 -G monitor monitor
COPY --from=build /out/ /usr/local/bin/
COPY LICENSE /usr/share/licenses/midden/LICENSE
USER 10001:10001
ENTRYPOINT ["core"]
