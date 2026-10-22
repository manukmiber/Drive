// Zeiko media container (SPEC §11): ffmpeg for videos that Media Transformations can't take
// (> 60 s or ≥ 100 MB) and images above the Images binding input limit. The input is spooled to
// local disk, transcoded, and returned with Content-Length plus SHA-256/CRC32 headers so the
// Worker can stream it straight into R2.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"hash/crc32"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

var presets = map[string]string{"1080p": "1080", "720p": "720", "480p": "480"}

func spool(r *http.Request) (string, func(), error) {
	dir, err := os.MkdirTemp("", "zk-media-")
	if err != nil {
		return "", nil, err
	}
	cleanup := func() { os.RemoveAll(dir) }
	in := filepath.Join(dir, "in")
	f, err := os.Create(in)
	if err != nil {
		cleanup()
		return "", nil, err
	}
	if _, err := io.Copy(f, r.Body); err != nil {
		f.Close()
		cleanup()
		return "", nil, err
	}
	f.Close()
	return in, cleanup, nil
}

func probe(path string) (float64, error) {
	out, err := exec.Command("ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", path).Output()
	if err != nil {
		return 0, err
	}
	var p struct {
		Format struct {
			Duration string `json:"duration"`
		} `json:"format"`
	}
	if err := json.Unmarshal(out, &p); err != nil {
		return 0, err
	}
	return strconv.ParseFloat(p.Format.Duration, 64)
}

func send(w http.ResponseWriter, path, contentType string, extra map[string]string) {
	f, err := os.Open(path)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	defer f.Close()
	sha := sha256.New()
	crc := crc32.NewIEEE()
	size, err := io.Copy(io.MultiWriter(sha, crc), f)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	w.Header().Set("X-SHA256", hex.EncodeToString(sha.Sum(nil)))
	w.Header().Set("X-CRC32", strconv.FormatUint(uint64(crc.Sum32()), 10))
	for k, v := range extra {
		w.Header().Set(k, v)
	}
	_, _ = io.Copy(w, f)
}

func run(args ...string) error {
	cmd := exec.Command("ffmpeg", append([]string{"-hide_banner", "-loglevel", "error", "-y"}, args...)...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%v: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func video(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	height := presets[q.Get("preset")]
	if height == "" {
		height = "720"
	}
	crf, _ := strconv.Atoi(q.Get("crf"))
	if crf < 18 || crf > 35 {
		crf = 26
	}
	codec := "libx264"
	if q.Get("codec") == "h265" {
		codec = "libx265"
	}
	in, cleanup, err := spool(r)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	defer cleanup()
	dur, _ := probe(in)
	out := in + ".mp4"
	// Never upscale: min(height, source height); keep aspect, even width.
	vf := fmt.Sprintf("scale=-2:'min(%s,ih)'", height)
	if err := run("-i", in, "-map", "0:v:0", "-map", "0:a?", "-c:v", codec, "-crf", strconv.Itoa(crf), "-preset", "veryfast",
		"-vf", vf, "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", out); err != nil {
		http.Error(w, err.Error(), 422)
		return
	}
	send(w, out, "video/mp4", map[string]string{"X-Duration": strconv.FormatFloat(dur, 'f', 2, 64)})
}

func image(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	format := q.Get("format")
	quality, _ := strconv.Atoi(q.Get("quality"))
	if quality < 1 || quality > 100 {
		quality = 80
	}
	width, _ := strconv.Atoi(q.Get("width"))
	in, cleanup, err := spool(r)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	defer cleanup()
	args := []string{"-i", in, "-map_metadata", "-1"}
	if width > 0 {
		args = append(args, "-vf", fmt.Sprintf("scale='min(%d,iw)':-2", width))
	}
	ext, ctype := ".jpg", "image/jpeg"
	switch format {
	case "webp":
		ext, ctype = ".webp", "image/webp"
		args = append(args, "-c:v", "libwebp", "-quality", strconv.Itoa(quality))
	case "avif":
		ext, ctype = ".avif", "image/avif"
		args = append(args, "-c:v", "libaom-av1", "-still-picture", "1", "-crf", strconv.Itoa(63-quality*63/100))
	default:
		args = append(args, "-q:v", strconv.Itoa(2+(100-quality)*29/100))
	}
	out := in + ext
	if err := run(append(args, "-frames:v", "1", out)...); err != nil {
		http.Error(w, err.Error(), 422)
		return
	}
	send(w, out, ctype, nil)
}

func probeHandler(w http.ResponseWriter, r *http.Request) {
	in, cleanup, err := spool(r)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	defer cleanup()
	dur, err := probe(in)
	if err != nil {
		http.Error(w, err.Error(), 422)
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]float64{"duration": dur})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("/video", video)
	mux.HandleFunc("/image", image)
	mux.HandleFunc("/probe", probeHandler)
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok")) })
	log.Println("media listening on :8080")
	srv := &http.Server{Addr: ":8080", Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	log.Fatal(srv.ListenAndServe())
}
