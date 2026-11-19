package capture

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// startProxy runs a proxy on a free port and returns it with its settings.
func startProxy(t *testing.T, opts Options) (*Proxy, Settings) {
	t.Helper()
	if opts.CADir == "" {
		opts.CADir = t.TempDir()
	}
	p, err := New(opts)
	if err != nil {
		t.Fatal(err)
	}
	settings, err := p.Start()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = p.Stop() })
	return p, settings
}

// clientThrough builds a client whose traffic goes through the proxy.
func clientThrough(proxy Settings) *http.Client {
	proxyURL, err := url.Parse("http://" + proxy.Addr)
	if err != nil {
		panic(err)
	}
	return &http.Client{
		Transport: &http.Transport{Proxy: http.ProxyURL(proxyURL)},
		Timeout:   5 * time.Second,
	}
}

func TestProxyForwardsAndCapturesHTTP(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"echo":"` + string(body) + `"}`))
	}))
	defer target.Close()

	var mu sync.Mutex
	var captured []Traffic
	p, settings := startProxy(t, Options{OnTraffic: func(tr Traffic) {
		mu.Lock()
		captured = append(captured, tr)
		mu.Unlock()
	}})

	resp, err := clientThrough(settings).Post(target.URL+"/users", "application/json", strings.NewReader(`{"name":"Ada"}`))
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusCreated || !strings.Contains(string(body), "Ada") {
		t.Fatalf("response: %d %s", resp.StatusCode, body)
	}

	waitCaptured(t, &mu, &captured)
	mu.Lock()
	defer mu.Unlock()
	if len(captured) != 1 {
		t.Fatalf("captured %d exchanges, want 1", len(captured))
	}
	tr := captured[0]
	if tr.Method != "POST" || tr.Status != http.StatusCreated {
		t.Fatalf("traffic: %+v", tr)
	}
	if !strings.Contains(tr.RequestHTTP, `{"name":"Ada"}`) {
		t.Errorf("request body missing from the captured message:\n%s", tr.RequestHTTP)
	}
	if !strings.Contains(tr.ResponseHTTP, "201 Created") {
		t.Errorf("status line missing from the captured response:\n%s", tr.ResponseHTTP)
	}
	if p.Settings().Captured != 1 {
		t.Errorf("settings count: %d", p.Settings().Captured)
	}
}

func TestProxyListensOnTheRequestedPort(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()

	_, settings := startProxy(t, Options{Port: port})
	if settings.Port != port || settings.Addr != "127.0.0.1:"+strconv.Itoa(port) {
		t.Fatalf("settings: %+v", settings)
	}
	conn, err := net.DialTimeout("tcp", settings.Addr, time.Second)
	if err != nil {
		t.Fatalf("the proxy is not listening: %v", err)
	}
	conn.Close()
}

// TestProxyTerminatesTLS proves HTTPS is read, not just tunnelled: the client
// trusts Acro's root and the proxy records the plaintext request.
func TestProxyTerminatesTLS(t *testing.T) {
	target := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write([]byte("secret"))
	}))
	defer target.Close()

	targetRoots := x509.NewCertPool()
	targetRoots.AddCert(target.Certificate())

	var mu sync.Mutex
	var captured []Traffic
	p, settings := startProxy(t, Options{
		UpstreamTLS: &tls.Config{RootCAs: targetRoots},
		OnTraffic: func(tr Traffic) {
			mu.Lock()
			captured = append(captured, tr)
			mu.Unlock()
		},
	})

	// A client trusting Acro's root, with the proxy set for TLS too.
	roots, err := certPool(p.CACert())
	if err != nil {
		t.Fatal(err)
	}
	proxyURL, err := url.Parse("http://" + settings.Addr)
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{
		Timeout: 5 * time.Second,
		Transport: &http.Transport{
			Proxy:           http.ProxyURL(proxyURL),
			TLSClientConfig: &tls.Config{RootCAs: roots},
		},
	}
	resp, err := client.Get(target.URL + "/secret")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(body) != "secret" {
		t.Fatalf("body: %q", body)
	}

	waitCaptured(t, &mu, &captured)
	mu.Lock()
	defer mu.Unlock()
	if len(captured) != 1 {
		t.Fatalf("captured %d exchanges, want 1", len(captured))
	}
	if got := captured[0]; got.Scheme != "https" || !strings.Contains(got.RequestHTTP, "GET /secret") {
		t.Fatalf("traffic: %+v", got)
	}
}

// TestProxyRecordsUpstreamFailures proves a failed forward is recorded with its
// reason instead of disappearing, which is what makes the proxy useful when
// something is wrong with a target.
func TestProxyRecordsUpstreamFailures(t *testing.T) {
	target := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer target.Close()

	var mu sync.Mutex
	var captured []Traffic
	// The proxy keeps the system roots, which do not sign the test's target.
	p, settings := startProxy(t, Options{OnTraffic: func(tr Traffic) {
		mu.Lock()
		captured = append(captured, tr)
		mu.Unlock()
	}})

	roots, err := certPool(p.CACert())
	if err != nil {
		t.Fatal(err)
	}
	proxyURL, err := url.Parse("http://" + settings.Addr)
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{
		Timeout: 5 * time.Second,
		Transport: &http.Transport{
			Proxy:           http.ProxyURL(proxyURL),
			TLSClientConfig: &tls.Config{RootCAs: roots},
		},
	}
	resp, err := client.Get(target.URL)
	if err == nil {
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadGateway {
			t.Fatalf("status: %d", resp.StatusCode)
		}
	}

	waitCaptured(t, &mu, &captured)
	mu.Lock()
	defer mu.Unlock()
	if len(captured) != 1 || captured[0].Error == "" {
		t.Fatalf("captured: %+v", captured)
	}
}

func TestProxyRejectsNonAbsoluteRequests(t *testing.T) {
	_, settings := startProxy(t, Options{})
	req, err := http.NewRequest(http.MethodGet, "http://"+settings.Addr+"/relative", nil)
	if err != nil {
		t.Fatal(err)
	}
	// A direct (not proxied) request carries an origin-form path.
	resp, err := (&http.Client{Timeout: 2 * time.Second}).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status: %d", resp.StatusCode)
	}
}

// certPool trusts one PEM certificate, as a client trusts Acro's root.
func certPool(certPEM string) (*x509.CertPool, error) {
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM([]byte(certPEM)) {
		return nil, fmt.Errorf("the CA certificate did not parse")
	}
	return pool, nil
}

// TestProxyServesSOCKS5 proves a profile configured as SOCKS5 works, not only
// an HTTP one: the proxy must answer both on the same port.
func TestProxyServesSOCKS5(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("through socks"))
	}))
	defer target.Close()

	var mu sync.Mutex
	var captured []Traffic
	_, settings := startProxy(t, Options{OnTraffic: func(tr Traffic) {
		mu.Lock()
		captured = append(captured, tr)
		mu.Unlock()
	}})

	// The SOCKS5 greeting, then a CONNECT to the target's host and port.
	conn, err := net.Dial("tcp", settings.Addr)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := conn.Write([]byte{0x05, 0x01, 0x00}); err != nil {
		t.Fatal(err)
	}
	reply := make([]byte, 2)
	if _, err := io.ReadFull(conn, reply); err != nil {
		t.Fatal(err)
	}
	if reply[0] != 0x05 || reply[1] != 0x00 {
		t.Fatalf("SOCKS greeting reply: %v", reply)
	}

	targetURL, err := url.Parse(target.URL)
	if err != nil {
		t.Fatal(err)
	}
	targetHost, targetPortText, err := net.SplitHostPort(targetURL.Host)
	if err != nil {
		t.Fatal(err)
	}
	targetPort, err := strconv.Atoi(targetPortText)
	if err != nil {
		t.Fatal(err)
	}
	request := []byte{0x05, 0x01, 0x00, 0x03, byte(len(targetHost))}
	request = append(request, targetHost...)
	request = append(request, byte(targetPort>>8), byte(targetPort))
	if _, err := conn.Write(request); err != nil {
		t.Fatal(err)
	}
	if _, err := io.ReadFull(conn, make([]byte, 10)); err != nil {
		t.Fatal(err)
	}

	// Plain HTTP over the SOCKS tunnel: the proxy forwards it as usual.
	if _, err := conn.Write([]byte("GET /socks HTTP/1.1\r\nHost: " + targetURL.Host + "\r\nConnection: close\r\n\r\n")); err != nil {
		t.Fatal(err)
	}
	response, err := io.ReadAll(conn)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(response), "through socks") {
		t.Fatalf("response: %q", response)
	}

	waitCaptured(t, &mu, &captured)
	mu.Lock()
	defer mu.Unlock()
	if len(captured) != 1 {
		t.Fatalf("captured %d exchanges, want 1", len(captured))
	}
	if !strings.Contains(captured[0].RequestHTTP, "GET /socks") {
		t.Fatalf("traffic: %+v", captured[0])
	}
}

// TestProxyServesSOCKS5TLS proves the HTTPS path works through SOCKS too: a
// SOCKS tunnel carries raw bytes, and Acro must terminate TLS inside it.
func TestProxyServesSOCKS5TLS(t *testing.T) {
	target := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("tls through socks"))
	}))
	defer target.Close()

	targetRoots := x509.NewCertPool()
	targetRoots.AddCert(target.Certificate())
	var mu sync.Mutex
	var captured []Traffic
	p, settings := startProxy(t, Options{
		UpstreamTLS: &tls.Config{RootCAs: targetRoots},
		OnTraffic: func(tr Traffic) {
			mu.Lock()
			captured = append(captured, tr)
			mu.Unlock()
		},
	})

	targetURL, err := url.Parse(target.URL)
	if err != nil {
		t.Fatal(err)
	}
	host, portText, err := net.SplitHostPort(targetURL.Host)
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(portText)
	if err != nil {
		t.Fatal(err)
	}

	conn, err := net.Dial("tcp", settings.Addr)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	// Greeting, then CONNECT to the target.
	if _, err := conn.Write([]byte{0x05, 0x01, 0x00}); err != nil {
		t.Fatal(err)
	}
	if _, err := io.ReadFull(conn, make([]byte, 2)); err != nil {
		t.Fatal(err)
	}
	request := []byte{0x05, 0x01, 0x00, 0x03, byte(len(host))}
	request = append(request, host...)
	request = append(request, byte(port>>8), byte(port))
	if _, err := conn.Write(request); err != nil {
		t.Fatal(err)
	}
	if _, err := io.ReadFull(conn, make([]byte, 10)); err != nil {
		t.Fatal(err)
	}

	// TLS inside the tunnel, trusting Acro's root as a browser would.
	roots, err := certPool(p.CACert())
	if err != nil {
		t.Fatal(err)
	}
	tlsConn := tls.Client(conn, &tls.Config{RootCAs: roots, ServerName: host})
	if err := tlsConn.Handshake(); err != nil {
		t.Fatal(err)
	}
	if _, err := tlsConn.Write([]byte("GET /socks-tls HTTP/1.1\r\nHost: " + targetURL.Host + "\r\nConnection: close\r\n\r\n")); err != nil {
		t.Fatal(err)
	}
	response, err := io.ReadAll(tlsConn)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(response), "tls through socks") {
		t.Fatalf("response: %q", response)
	}

	waitCaptured(t, &mu, &captured)
	mu.Lock()
	defer mu.Unlock()
	if len(captured) != 1 || captured[0].Scheme != "https" || !strings.Contains(captured[0].RequestHTTP, "GET /socks-tls") {
		t.Fatalf("traffic: %+v", captured)
	}
}

// A forwarded response can reach the client just before its capture callback.
func waitCaptured(t *testing.T, mu *sync.Mutex, entries *[]Traffic) {
	t.Helper()
	deadline := time.NewTimer(2 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(time.Millisecond)
	defer ticker.Stop()
	for {
		mu.Lock()
		ready := len(*entries) > 0
		mu.Unlock()
		if ready {
			return
		}
		select {
		case <-ticker.C:
		case <-deadline.C:
			t.Fatal("capture callback did not complete")
		}
	}
}

func TestDumpProxyRequestPreservesVirtualHostAndBody(t *testing.T) {
	r := httptest.NewRequest("POST", "http://127.0.0.1:8080/upload?q=1", nil)
	r.Host = "virtual.example.test"
	r.Header.Set("Content-Type", "text/plain")
	body := []byte("line one\r\nline two")
	got := dumpRequest(r, body)
	if !strings.HasPrefix(got, "POST /upload?q=1 HTTP/1.1\r\n") || !strings.Contains(got, "Host: virtual.example.test\r\n") || !strings.HasSuffix(got, "\r\n\r\n"+string(body)) {
		t.Fatalf("capture lost request fields: %q", got)
	}
	if r.URL.Scheme != "http" || r.URL.Host != "127.0.0.1:8080" {
		t.Fatalf("dump mutated the original URL: %s", r.URL)
	}
}

func TestCaptureSequenceSurvivesClearAndListenerRestart(t *testing.T) {
	var entries []Traffic
	p, _ := startProxy(t, Options{OnTraffic: func(tr Traffic) { entries = append(entries, tr) }})
	p.record(Traffic{ID: "first"})
	p.Reset()
	p.record(Traffic{ID: "second"})
	if err := p.Stop(); err != nil {
		t.Fatal(err)
	}
	if _, err := p.Start(); err != nil {
		t.Fatal(err)
	}
	p.record(Traffic{ID: "third"})
	for i, entry := range entries {
		if entry.Sequence != uint64(i+1) {
			t.Fatalf("sequence = %d, want %d", entry.Sequence, i+1)
		}
	}
	if got := p.Settings().Captured; got != 2 {
		t.Fatalf("captured = %d, want 2 after clear", got)
	}
}

func TestConcurrentCaptureSequencesFollowDeliveryOrder(t *testing.T) {
	var entries []Traffic
	p := &Proxy{opts: Options{OnTraffic: func(tr Traffic) { entries = append(entries, tr) }}}
	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); p.record(Traffic{}) }()
	}
	wg.Wait()
	for i, entry := range entries {
		if entry.Sequence != uint64(i+1) {
			t.Fatalf("sequence = %d, want %d", entry.Sequence, i+1)
		}
	}
}
