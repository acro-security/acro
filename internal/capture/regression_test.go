package capture

import (
	"bufio"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestIdleClientDoesNotBlockOtherConnections(t *testing.T) {
	_, settings := startProxy(t, Options{})
	idle, err := net.Dial("tcp", settings.Addr)
	if err != nil {
		t.Fatal(err)
	}
	defer idle.Close()
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, "ok") }))
	defer target.Close()
	client := clientThrough(settings)
	client.Timeout = time.Second
	resp, err := client.Get(target.URL)
	if err != nil {
		t.Fatalf("idle connection blocked proxy: %v", err)
	}
	defer resp.Body.Close()
}

func TestStopClosesConnectionsAndUpdatesState(t *testing.T) {
	p, settings := startProxy(t, Options{})
	conn, err := net.Dial("tcp", settings.Addr)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
	_, _ = io.WriteString(conn, "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n")
	resp, err := http.ReadResponse(bufio.NewReader(conn), &http.Request{Method: "CONNECT"})
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 200 {
		t.Fatal(resp.Status)
	}
	if err := p.Stop(); err != nil {
		t.Fatal(err)
	}
	if p.Settings().Running {
		t.Error("stopped proxy still reports Running")
	}
	var b [1]byte
	if _, err := conn.Read(b[:]); err == nil {
		t.Error("hijacked connection stayed open")
	} else if timeout, ok := err.(net.Error); ok && timeout.Timeout() {
		t.Error("Stop left the tunnel blocked")
	}
}

func TestLargeBodiesAreForwardedInFull(t *testing.T) {
	body := strings.Repeat("payload-", MaxBodyBytes/8+512)
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got, err := io.ReadAll(r.Body)
		if err != nil || string(got) != body {
			t.Errorf("upload truncated: got %d, want %d (%v)", len(got), len(body), err)
		}
		_, _ = io.WriteString(w, body)
	}))
	defer target.Close()
	recorded := make(chan Traffic, 1)
	_, settings := startProxy(t, Options{OnTraffic: func(tr Traffic) { recorded <- tr }})
	resp, err := clientThrough(settings).Post(target.URL, "application/octet-stream", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err != nil || string(got) != body {
		t.Fatalf("download truncated: got %d, want %d (%v)", len(got), len(body), err)
	}
	select {
	case tr := <-recorded:
		if !tr.Truncated {
			t.Error("capture must report its retention limit")
		}
		if len(tr.RequestHTTP) > MaxBodyBytes+4096 || len(tr.ResponseHTTP) > MaxBodyBytes+4096 {
			t.Error("retained captures exceeded the body limit")
		}
	case <-time.After(time.Second):
		t.Fatal("traffic was not recorded")
	}
}

func TestTLSHeadAndEmptyResponsesKeepConnectionUsable(t *testing.T) {
	target := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/empty" {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		w.Header().Set("Content-Length", "7")
		if r.Method != "HEAD" {
			_, _ = io.WriteString(w, "payload")
		}
	}))
	defer target.Close()
	root := x509.NewCertPool()
	root.AddCert(target.Certificate())
	p, settings := startProxy(t, Options{UpstreamTLS: &tls.Config{RootCAs: root}})
	conn, err := net.Dial("tcp", settings.Addr)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
	host := strings.TrimPrefix(target.URL, "https://")
	_, _ = io.WriteString(conn, "CONNECT "+host+" HTTP/1.1\r\nHost: "+host+"\r\n\r\n")
	reader := bufio.NewReader(conn)
	if _, err := http.ReadResponse(reader, &http.Request{Method: "CONNECT"}); err != nil {
		t.Fatal(err)
	}
	roots, _ := certPool(p.CACert())
	tlsConn := tls.Client(conn, &tls.Config{RootCAs: roots, ServerName: "127.0.0.1"})
	defer tlsConn.Close()
	if err := tlsConn.Handshake(); err != nil {
		t.Fatal(err)
	}
	reader = bufio.NewReader(tlsConn)
	for _, test := range []struct {
		method, path string
		status       int
	}{{"HEAD", "/", 200}, {"GET", "/empty", 204}, {"GET", "/", 200}} {
		_, _ = io.WriteString(tlsConn, test.method+" "+test.path+" HTTP/1.1\r\nHost: "+host+"\r\n\r\n")
		resp, err := http.ReadResponse(reader, &http.Request{Method: test.method})
		if err != nil {
			t.Fatalf("%s %s: %v", test.method, test.path, err)
		}
		body, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil || resp.StatusCode != test.status {
			t.Fatalf("%s %s: response %d: %v body=%q", test.method, test.path, resp.StatusCode, err, body)
		}
		if test.method == "HEAD" && resp.ContentLength != 7 {
			t.Fatalf("HEAD lost the representation length: %d", resp.ContentLength)
		}
		if test.method == "GET" && test.path == "/" && string(body) != "payload" {
			t.Fatalf("body: %q", body)
		}
	}
}

func TestResponseIsStreamedBeforeUpstreamCompletes(t *testing.T) {
	release := make(chan struct{})
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: first\n\n")
		w.(http.Flusher).Flush()
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer target.Close()
	defer close(release)
	_, settings := startProxy(t, Options{})
	client := clientThrough(settings)
	client.Timeout = time.Second
	resp, err := client.Get(target.URL)
	if err != nil {
		t.Fatalf("proxy buffered the streaming response: %v", err)
	}
	defer resp.Body.Close()
	line, err := bufio.NewReader(resp.Body).ReadString('\n')
	if err != nil || line != "data: first\n" {
		t.Fatalf("first event: %q %v", line, err)
	}
}

func TestHopHeadersAreRemovedInBothDirections(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Connection-Only") != "" || r.Header.Get("Proxy-Authorization") != "" {
			t.Error("connection headers leaked upstream")
		}
		w.Header().Set("Connection", "X-Private")
		w.Header().Set("X-Private", "secret")
		_, _ = io.WriteString(w, "ok")
	}))
	defer target.Close()
	_, settings := startProxy(t, Options{})
	req, _ := http.NewRequest("GET", target.URL, nil)
	req.Header.Set("Connection", "keep-alive, X-Connection-Only")
	req.Header.Set("X-Connection-Only", "secret")
	req.Header.Set("Proxy-Authorization", "secret")
	resp, err := clientThrough(settings).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.Header.Get("X-Private") != "" {
		t.Fatal("connection headers leaked downstream")
	}
}

func TestStopCancelsActiveForwardAndCanRestart(t *testing.T) {
	started, canceled := make(chan struct{}), make(chan struct{})
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { close(started); <-r.Context().Done(); close(canceled) }))
	defer target.Close()
	p, settings := startProxy(t, Options{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		resp, err := clientThrough(settings).Get(target.URL)
		if err == nil {
			resp.Body.Close()
		}
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("forward did not start")
	}
	if err := p.Stop(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-canceled:
	case <-time.After(time.Second):
		t.Fatal("Stop did not cancel upstream")
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("client stayed blocked")
	}
	s, err := p.Start()
	if err != nil || !s.Running {
		t.Fatalf("restart: %+v %v", s, err)
	}
}

// A client may pipeline its TLS ClientHello in the same write as CONNECT.
type eagerCONNECT struct {
	net.Conn
	target         string
	reader         *bufio.Reader
	sent, answered bool
}

func (c *eagerCONNECT) Write(b []byte) (int, error) {
	if c.sent {
		return c.Conn.Write(b)
	}
	c.sent = true
	prefix := []byte("CONNECT " + c.target + " HTTP/1.1\r\nHost: " + c.target + "\r\n\r\n")
	n, err := c.Conn.Write(append(prefix, b...))
	return max(0, n-len(prefix)), err
}
func (c *eagerCONNECT) Read(b []byte) (int, error) {
	if !c.answered {
		c.answered = true
		resp, err := http.ReadResponse(c.reader, &http.Request{Method: "CONNECT"})
		if err != nil {
			return 0, err
		}
		if resp.StatusCode != 200 {
			return 0, fmt.Errorf("CONNECT: %s", resp.Status)
		}
	}
	return c.reader.Read(b)
}

func TestCONNECTPreservesBufferedTLSHandshake(t *testing.T) {
	target := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, "buffered hello") }))
	defer target.Close()
	upstream := x509.NewCertPool()
	upstream.AddCert(target.Certificate())
	p, settings := startProxy(t, Options{UpstreamTLS: &tls.Config{RootCAs: upstream}})
	conn, err := net.Dial("tcp", settings.Addr)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
	eager := &eagerCONNECT{Conn: conn, target: strings.TrimPrefix(target.URL, "https://"), reader: bufio.NewReader(conn)}
	roots, _ := certPool(p.CACert())
	secure := tls.Client(eager, &tls.Config{RootCAs: roots, ServerName: "127.0.0.1"})
	defer secure.Close()
	if err = secure.Handshake(); err != nil {
		t.Fatalf("buffered ClientHello lost: %v", err)
	}
	_, _ = io.WriteString(secure, "GET / HTTP/1.1\r\nHost: "+eager.target+"\r\nConnection: close\r\n\r\n")
	resp, err := http.ReadResponse(bufio.NewReader(secure), &http.Request{Method: "GET"})
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil || string(body) != "buffered hello" {
		t.Fatalf("body %q: %v", body, err)
	}
}

func TestBinaryPayloadsRemainIntactAndCapturesUseBase64(t *testing.T) {
	body := []byte{0xff, 0, 0xfe, 0x80}
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.Copy(w, r.Body) }))
	defer target.Close()
	recorded := make(chan Traffic, 1)
	_, settings := startProxy(t, Options{OnTraffic: func(tr Traffic) { recorded <- tr }})
	resp, err := clientThrough(settings).Post(target.URL, "application/octet-stream", strings.NewReader(string(body)))
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err != nil || string(got) != string(body) {
		t.Fatalf("binary transfer changed: %v %v", got, err)
	}
	select {
	case tr := <-recorded:
		encoded := base64.StdEncoding.EncodeToString(body)
		if tr.RequestEncoding != "base64" || tr.Encoding != "base64" || !strings.Contains(tr.RequestHTTP, encoded) || !strings.Contains(tr.ResponseHTTP, encoded) {
			t.Fatalf("invalid binary capture: %+v", tr)
		}
	case <-time.After(time.Second):
		t.Fatal("capture missing")
	}
}

func TestAuthorityRejectsMismatchedKey(t *testing.T) {
	_, cert, _, err := newAuthority()
	if err != nil {
		t.Fatal(err)
	}
	_, _, otherKey, err := newAuthority()
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := parseCA(cert, otherKey); err == nil {
		t.Fatal("mismatched certificate/key accepted")
	}
	if got := canonicalHost("[::1]"); got != "::1" {
		t.Fatalf("IPv6 host: %s", got)
	}
}
