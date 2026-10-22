# Zeiko media: ffmpeg (H.264/H.265 + AAC, WebP/AVIF/JPEG). Instance type standard-2 (ADR-015).
FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod main.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /media .

FROM alpine:3.20
RUN apk add --no-cache ffmpeg
COPY --from=build /media /usr/local/bin/media
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/media"]
