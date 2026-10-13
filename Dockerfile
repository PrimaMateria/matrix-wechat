FROM golang:1.27.2-alpine3.23 AS builder
RUN apk add --no-cache build-base
WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG VERSION=unknown
ARG COMMIT=unknown
ARG BUILD_TIME=unknown
RUN CGO_ENABLED=1 go build -tags goolm -trimpath -ldflags "-s -w -X main.Tag=${VERSION} -X main.Commit=${COMMIT} -X main.BuildTime=${BUILD_TIME}" -o /out/matrix-wechat ./cmd/matrix-wechat

FROM alpine:3.23
RUN apk add --no-cache ca-certificates ffmpeg tzdata
COPY --from=builder /out/matrix-wechat /usr/bin/matrix-wechat
COPY example-config.yaml /opt/matrix-wechat/example-config.yaml
COPY docker-run.sh /usr/bin/docker-run.sh
RUN chmod 755 /usr/bin/docker-run.sh
LABEL org.opencontainers.image.source="https://github.com/yamada-sexta/matrix-wechat"
VOLUME /data
WORKDIR /data
EXPOSE 17778
ENTRYPOINT ["/usr/bin/docker-run.sh"]
