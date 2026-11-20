package capture

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestProxyUpgradeCapturesHandshakeAndRelaysBothDirections(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Upgrade") != "websocket" || !headerToken(r.Header, "Connection", "upgrade") {
			t.Error("upgrade headers missing")
			http.Error(w, "missing upgrade", 400)
			return
		}
		conn, buffer, err := w.(http.Hijacker).Hijack()
		if err != nil {
			return
		}
		defer conn.Close()
		_, _ = buffer.WriteString("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n")
		_ = buffer.Flush()
		_, _ = io.Copy(conn, buffer)
	}))
	defer upstream.Close()
	captured := make(chan Traffic, 1)
	proxy, settings := startProxy(t, Options{OnTraffic: func(tr Traffic) { captured <- tr }})
	conn, err := net.Dial("tcp", settings.Addr)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
	_, _ = fmt.Fprintf(conn, "GET %s/socket HTTP/1.1\r\nHost: fixture\r\nConnection: keep-alive, Upgrade\r\nUpgrade: websocket\r\n\r\n", upstream.URL)
	reader := bufio.NewReader(conn)
	resp, err := http.ReadResponse(reader, &http.Request{Method: "GET"})
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 101 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	select {
	case tr := <-captured:
		if tr.Status != 101 {
			t.Fatalf("capture status %d", tr.Status)
		}
	case <-time.After(time.Second):
		t.Fatal("handshake not recorded while connection is open")
	}
	_, _ = conn.Write([]byte("ping"))
	got := make([]byte, 4)
	if _, err = io.ReadFull(reader, got); err != nil || string(got) != "ping" {
		t.Fatalf("duplex stream: %q %v", got, err)
	}
	if err := proxy.Stop(); err != nil {
		t.Fatal(err)
	}
	if _, err := reader.ReadByte(); err == nil {
		t.Fatal("proxy stop left the upgraded connection open")
	} else if timeout, ok := err.(net.Error); ok && timeout.Timeout() {
		t.Fatal("upgraded connection timed out instead of closing on proxy stop")
	}
}
