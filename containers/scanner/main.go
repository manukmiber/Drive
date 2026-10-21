// Zeiko scanner container (SPEC §14.2): reads the file once as a stream, computes SHA-256 + CRC32,
// returns the first bytes for MIME sniffing and, for files up to the scan limit, streams them to
// clamd (INSTREAM). File content never leaves this container.
package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"hash/crc32"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"time"
)

const headBytes = 4096

type result struct {
	SHA256   string `json:"sha256"`
	CRC32    uint32 `json:"crc32"`
	Size     int64  `json:"size"`
	Head     string `json:"head"`
	Scanned  bool   `json:"scanned"`
	Infected bool   `json:"infected"`
	Virus    string `json:"virus,omitempty"`
	Error    string `json:"error,omitempty"`
}

type clamStream struct {
	conn net.Conn
	w    *bufio.Writer
}

func openClam() (*clamStream, error) {
	addr := os.Getenv("CLAMD_ADDR")
	if addr == "" {
		addr = "127.0.0.1:3310"
	}
	conn, err := net.DialTimeout("tcp", addr, 5*time.Second)
	if err != nil {
		return nil, err
	}
	_ = conn.SetDeadline(time.Now().Add(30 * time.Minute))
	w := bufio.NewWriterSize(conn, 64*1024)
	if _, err := w.WriteString("zINSTREAM\x00"); err != nil {
		conn.Close()
		return nil, err
	}
	return &clamStream{conn: conn, w: w}, nil
}

func (c *clamStream) Write(p []byte) (int, error) {
	var hdr [4]byte
	binary.BigEndian.PutUint32(hdr[:], uint32(len(p)))
	if _, err := c.w.Write(hdr[:]); err != nil {
		return 0, err
	}
	return c.w.Write(p)
}

func (c *clamStream) finish() (bool, string, error) {
	defer c.conn.Close()
	if _, err := c.w.Write([]byte{0, 0, 0, 0}); err != nil {
		return false, "", err
	}
	if err := c.w.Flush(); err != nil {
		return false, "", err
	}
	reply, err := bufio.NewReader(c.conn).ReadString('\x00')
	if err != nil && !errors.Is(err, io.EOF) {
		return false, "", err
	}
	reply = strings.TrimRight(strings.TrimSpace(reply), "\x00")
	switch {
	case strings.HasSuffix(reply, "OK"):
		return false, "", nil
	case strings.HasSuffix(reply, "FOUND"):
		sig := strings.TrimSuffix(strings.TrimPrefix(reply, "stream: "), " FOUND")
		return true, sig, nil
	default:
		return false, "", errors.New("clamd: " + reply)
	}
}

// headWriter keeps the first headBytes bytes.
type headWriter struct{ buf []byte }

func (h *headWriter) Write(p []byte) (int, error) {
	if room := headBytes - len(h.buf); room > 0 {
		if len(p) < room {
			room = len(p)
		}
		h.buf = append(h.buf, p[:room]...)
	}
	return len(p), nil
}

func scan(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method", http.StatusMethodNotAllowed)
		return
	}
	doScan := r.URL.Query().Get("scan") == "1"
	sha := sha256.New()
	crc := crc32.NewIEEE()
	head := &headWriter{}
	writers := []io.Writer{sha, crc, head}
	var clam *clamStream
	res := result{}
	if doScan {
		c, err := openClam()
		if err != nil {
			res.Error = "clamd unavailable: " + err.Error()
		} else {
			clam = c
			writers = append(writers, clam)
		}
	}
	n, err := io.CopyBuffer(io.MultiWriter(writers...), r.Body, make([]byte, 256*1024))
	res.Size = n
	if err != nil {
		res.Error = "read: " + err.Error()
	}
	res.SHA256 = hex.EncodeToString(sha.Sum(nil))
	res.CRC32 = crc.Sum32()
	res.Head = base64.StdEncoding.EncodeToString(head.buf)
	if clam != nil && res.Error == "" {
		infected, sig, cerr := clam.finish()
		if cerr != nil {
			res.Error = cerr.Error()
		} else {
			res.Scanned = true
			res.Infected = infected
			res.Virus = sig
		}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(res)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("/scan", scan)
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok")) })
	log.Println("scanner listening on :8080")
	log.Fatal((&http.Server{Addr: ":8080", Handler: mux, ReadHeaderTimeout: 10 * time.Second}).ListenAndServe())
}
