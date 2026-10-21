# Zeiko scanner: ClamAV (clamd) + streaming hasher. Instance type standard-1 (4 GiB RAM, ADR-015).
FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod main.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /scanner .

FROM clamav/clamav:stable
# Allow streams up to the scan limit (SPEC §14.2 default 512 MB) and listen on TCP.
RUN sed -i 's/^#\?StreamMaxLength.*/StreamMaxLength 600M/' /etc/clamav/clamd.conf \
 && sed -i 's/^#\?MaxFileSize.*/MaxFileSize 600M/' /etc/clamav/clamd.conf \
 && sed -i 's/^#\?MaxScanSize.*/MaxScanSize 1200M/' /etc/clamav/clamd.conf \
 && (grep -q '^TCPSocket' /etc/clamav/clamd.conf || echo 'TCPSocket 3310' >> /etc/clamav/clamd.conf) \
 && (grep -q '^TCPAddr' /etc/clamav/clamd.conf || echo 'TCPAddr 127.0.0.1' >> /etc/clamav/clamd.conf)
COPY --from=build /scanner /usr/local/bin/scanner
COPY start.sh /start.sh
RUN chmod +x /start.sh
EXPOSE 8080
ENTRYPOINT ["/start.sh"]
