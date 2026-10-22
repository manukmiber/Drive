// Zeiko archiver (SPEC §7.2): the Worker streams a tar of the selection; this container compresses
// it to local disk (zstd multi-threaded, or re-packs it as a deflate ZIP) and returns the result with
// Content-Length + SHA-256 so the Worker can write it to R2. No R2/S3 credentials live here (ADR-033).
package main

import (
	"archive/tar"
	"archive/zip"
	"compress/flate"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

func zstd(in io.Reader, out string, level int) error {
	if level < 1 {
		level = 3
	}
	args := []string{"-T0", "-q", "-f", "-o", out}
	if level > 19 {
		args = append(args, "--ultra")
	}
	args = append(args, fmt.Sprintf("-%d", level))
	cmd := exec.Command("zstd", args...)
	cmd.Stdin = in
	if b, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("zstd: %v: %s", err, strings.TrimSpace(string(b)))
	}
	return nil
}

func tarToZip(in io.Reader, out string, level int) error {
	f, err := os.Create(out)
	if err != nil {
		return err
	}
	defer f.Close()
	if level < 1 || level > 9 {
		level = 6
	}
	zw := zip.NewWriter(f)
	zw.RegisterCompressor(zip.Deflate, func(w io.Writer) (io.WriteCloser, error) { return flate.NewWriter(w, level) })
	tr := tar.NewReader(in)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		switch h.Typeflag {
		case tar.TypeDir:
			name := strings.TrimSuffix(h.Name, "/") + "/"
			if _, err := zw.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Store, Modified: h.ModTime}); err != nil {
				return err
			}
		case tar.TypeReg:
			fh := &zip.FileHeader{Name: h.Name, Method: zip.Deflate, Modified: h.ModTime}
			fh.SetMode(0o644)
			w, err := zw.CreateHeader(fh)
			if err != nil {
				return err
			}
			if _, err := io.Copy(w, tr); err != nil {
				return err
			}
		}
	}
	return zw.Close()
}

func build(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method", 405)
		return
	}
	format := r.URL.Query().Get("format")
	level, _ := strconv.Atoi(r.URL.Query().Get("level"))
	dir, err := os.MkdirTemp("", "zk-archive-")
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	defer os.RemoveAll(dir)
	out := dir + "/out"
	ctype := "application/zstd"
	switch format {
	case "tar_zst":
		err = zstd(r.Body, out, level)
	case "zip_deflate":
		ctype = "application/zip"
		err = tarToZip(r.Body, out, level)
	default:
		http.Error(w, "unknown format", 400)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), 422)
		return
	}
	f, err := os.Open(out)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	defer f.Close()
	sum := sha256.New()
	size, err := io.Copy(sum, f)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	w.Header().Set("Content-Type", ctype)
	w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	w.Header().Set("X-SHA256", hex.EncodeToString(sum.Sum(nil)))
	_, _ = io.Copy(w, f)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("/build", build)
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok")) })
	log.Println("archiver listening on :8080")
	srv := &http.Server{Addr: ":8080", Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	log.Fatal(srv.ListenAndServe())
}
