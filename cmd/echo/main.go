// Local target for trying the native replayer without external services.
package main

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"time"
)

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("/echo", func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 2<<20))
		if err != nil {
			http.Error(w, "Request body exceeds 2 MiB", http.StatusRequestEntityTooLarge)
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"method":  r.Method,
			"path":    r.URL.Path,
			"query":   r.URL.Query(),
			"body":    string(body),
			"message": "Hello from Acro",
		})
	})
	server := &http.Server{Addr: "127.0.0.1:7777", Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	log.Print("Acro echo target: http://127.0.0.1:7777/echo")
	log.Fatal(server.ListenAndServe())
}
