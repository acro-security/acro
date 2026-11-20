package capture

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
)

func headerToken(h http.Header, name, token string) bool {
	for _, value := range h.Values(name) {
		for _, part := range strings.Split(value, ",") {
			if strings.EqualFold(strings.TrimSpace(part), token) {
				return true
			}
		}
	}
	return false
}

// A WebSocket is a duplex stream after its HTTP handshake. Capture the
// handshake immediately; frames must not be mistaken for an HTTP body.
func relayUpgrade(w http.ResponseWriter, r *http.Request, resp *http.Response, record func()) error {
	upstream, ok := resp.Body.(io.ReadWriteCloser)
	if !ok {
		return errors.New("Upstream upgrade has no duplex connection")
	}
	h, ok := w.(http.Hijacker)
	if !ok {
		return errors.New("Protocol upgrades require HTTP/1.1")
	}
	downstream, buffer, err := h.Hijack()
	if err != nil {
		return err
	}
	defer downstream.Close()
	stop := context.AfterFunc(r.Context(), func() { _ = downstream.Close(); _ = upstream.Close() })
	defer stop()
	if _, err = buffer.WriteString(dumpResponse(resp, nil)); err != nil {
		return err
	}
	if err = buffer.Flush(); err != nil {
		return err
	}
	record()
	done := make(chan struct{})
	go func() { defer close(done); _, _ = io.Copy(upstream, buffer); _ = upstream.Close() }()
	_, _ = io.Copy(downstream, upstream)
	_ = downstream.Close()
	_ = upstream.Close()
	<-done
	return nil
}
