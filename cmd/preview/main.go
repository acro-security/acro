// Browser development transport. The desktop app calls the same Go code over
// mygo IPC; this server mirrors that surface for a browser, so what you develop
// against in a page is what the app runs.
package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"acro/internal/capture"
	"acro/internal/replay"
)

// hub fans captured exchanges out to the browser pages that watch them.
type hub struct {
	mu     sync.Mutex
	subs   map[chan streamEvent]struct{}
	recent []capture.Traffic
}

type streamEvent struct {
	name string
	data any
}

func (h *hub) publish(t capture.Traffic) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.recent = append(h.recent, t)
	if len(h.recent) > 500 {
		h.recent = h.recent[len(h.recent)-500:]
	}
	for ch := range h.subs {
		select {
		case ch <- streamEvent{"traffic", t}:
		default: // a slow page skips, never blocks the proxy
		}
	}
}

func (h *hub) state(settings capture.Settings) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.subs {
		select {
		case ch <- streamEvent{"state", settings}:
		default:
		}
	}
}

func (h *hub) subscribe() chan streamEvent {
	ch := make(chan streamEvent, 32)
	h.mu.Lock()
	h.subs[ch] = struct{}{}
	h.mu.Unlock()
	return ch
}

func (h *hub) unsubscribe(ch chan streamEvent) {
	h.mu.Lock()
	delete(h.subs, ch)
	h.mu.Unlock()
}

func main() {
	addr := os.Getenv("ACRO_DEV_ADDR")
	if addr == "" {
		addr = "127.0.0.1:7777"
	}
	port := 8081
	if value := os.Getenv("ACRO_PROXY_PORT"); value != "" {
		var err error
		port, err = strconv.Atoi(value)
		if err != nil {
			log.Fatal("Invalid ACRO_PROXY_PORT: ", err)
		}
	}
	events := &hub{subs: map[chan streamEvent]struct{}{}}
	proxy, err := capture.New(capture.Options{
		Port:  port,
		CADir: filepath.Join(configDir(), "acro", "proxy"),
		OnTraffic: func(t capture.Traffic) {
			events.publish(t)
		},
		OnState: events.state,
		OnReset: func() { events.mu.Lock(); events.recent = nil; events.mu.Unlock() },
	})
	if err != nil {
		log.Fatal(err)
	}
	defer proxy.Stop()

	engine := replay.Engine{}
	api := &api{engine: engine, proxy: proxy, events: events}

	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/replay", api.replay)
	mux.HandleFunc("GET /api/capture/status", api.status)
	mux.HandleFunc("GET /api/capture/history", api.history)
	mux.HandleFunc("POST /api/capture/start", api.start)
	mux.HandleFunc("POST /api/capture/stop", api.stop)
	mux.HandleFunc("POST /api/capture/clear", api.clear)
	mux.HandleFunc("GET /api/capture/ca", api.certificate)
	mux.HandleFunc("GET /api/capture/stream", api.stream)
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("ok"))
	})
	// A local, deterministic target for trying replay without external services.
	mux.HandleFunc("/echo", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"method":  r.Method,
			"path":    r.URL.Path,
			"query":   r.URL.Query(),
			"message": "Hello from Acro",
		})
	})

	server := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	log.Print("Acro development API: http://", addr)
	log.Fatal(server.ListenAndServe())
}

// api serves the page's calls, each mapping to a bound Go method in the app.
type api struct {
	engine replay.Engine
	proxy  *capture.Proxy
	events *hub
}

func (a *api) allowed(w http.ResponseWriter, r *http.Request) bool {
	if sameMachine(r.Header.Get("Origin")) {
		return true
	}
	http.Error(w, "origin rejected", http.StatusForbidden)
	return false
}

func (a *api) replay(w http.ResponseWriter, r *http.Request) {
	if !a.allowed(w, r) {
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if r.Header.Get("Content-Type") != "application/json" {
		w.WriteHeader(http.StatusUnsupportedMediaType)
		return
	}
	var input replay.Input
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2<<20)).Decode(&input); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "Invalid request JSON"})
		return
	}
	result, err := a.engine.Execute(r.Context(), input)
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	_ = json.NewEncoder(w).Encode(result)
}

func (a *api) status(w http.ResponseWriter, r *http.Request) {
	if !a.allowed(w, r) {
		return
	}
	writeJSON(w, a.proxy.Settings())
}

func (a *api) start(w http.ResponseWriter, r *http.Request) {
	if !a.allowed(w, r) {
		return
	}
	settings, err := a.proxy.Start()
	if err != nil {
		w.WriteHeader(http.StatusBadGateway)
		writeJSON(w, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, settings)
}

func (a *api) stop(w http.ResponseWriter, r *http.Request) {
	if !a.allowed(w, r) {
		return
	}
	_ = a.proxy.Stop()
	writeJSON(w, a.proxy.Settings())
}

func (a *api) clear(w http.ResponseWriter, r *http.Request) {
	if !a.allowed(w, r) {
		return
	}
	a.proxy.Reset()
	writeJSON(w, a.proxy.Settings())
}

func (a *api) history(w http.ResponseWriter, r *http.Request) {
	if !a.allowed(w, r) {
		return
	}
	a.events.mu.Lock()
	items := append([]capture.Traffic{}, a.events.recent...)
	a.events.mu.Unlock()
	writeJSON(w, items)
}

func (a *api) certificate(w http.ResponseWriter, r *http.Request) {
	if !a.allowed(w, r) {
		return
	}
	w.Header().Set("Content-Type", "application/x-pem-file")
	w.Header().Set("Content-Disposition", `attachment; filename="acro-ca.pem"`)
	_, _ = w.Write([]byte(a.proxy.CACert()))
}

// stream sends captured exchanges as they happen, as mygo events do in the app.
func (a *api) stream(w http.ResponseWriter, r *http.Request) {
	if !a.allowed(w, r) {
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	ch := a.events.subscribe()
	defer a.events.unsubscribe(ch)
	// Tell a late page the current state at once.
	writeEvent(w, "state", a.proxy.Settings())
	flusher.Flush()
	heartbeat := time.NewTicker(20 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case event := <-ch:
			writeEvent(w, event.name, event.data)
			flusher.Flush()
		case <-heartbeat.C:
			// A comment keeps the connection alive through proxies.
			_, _ = fmt.Fprint(w, ": keep-alive\n\n")
			flusher.Flush()
		}
	}
}

func writeEvent(w http.ResponseWriter, name string, v any) {
	data, err := json.Marshal(v)
	if err != nil {
		return
	}
	_, _ = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", name, data)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func configDir() string {
	if dir, err := os.UserConfigDir(); err == nil {
		return dir
	}
	return os.TempDir()
}

// sameMachine reports whether origin is absent, as for a same-origin request,
// or names a loopback host.
func sameMachine(origin string) bool {
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	switch u.Hostname() {
	case "127.0.0.1", "localhost", "::1", "[::1]":
		return u.Scheme == "http" || u.Scheme == "https"
	}
	return false
}
