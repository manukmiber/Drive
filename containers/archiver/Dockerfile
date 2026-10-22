# Zeiko archiver: zstd (multi-threaded) + Go stdlib tar→zip. Instance type standard-2 (ADR-015).
FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod main.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /archiver .

FROM alpine:3.20
RUN apk add --no-cache zstd
COPY --from=build /archiver /usr/local/bin/archiver
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/archiver"]
