FROM golang:1.27.1-alpine3.23 AS build
ARG BUILD_PROCS=1
ENV GOMAXPROCS=${BUILD_PROCS} GOGC=50
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -p 1 -trimpath -o /out/core ./cmd/core && \
    CGO_ENABLED=0 go build -p 1 -trimpath -o /out/monitorctl ./cmd/monitorctl
FROM alpine:3.23.3
RUN apk add --no-cache ca-certificates && addgroup -g 10001 monitor && adduser -D -H -u 10001 -G monitor monitor
COPY --from=build /out/ /usr/local/bin/
USER 10001:10001
ENTRYPOINT ["core"]
