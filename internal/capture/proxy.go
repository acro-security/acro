// Package capture owns Acro's intercepting proxy: a local HTTP server that
// clients point at, which records every exchange and forwards it to the real
// target. HTTPS is read by terminating TLS with Acro's own certificate
// authority, so a client must trust its root.
//
// The package is transport-neutral. It records Traffic and lets a caller decide
// what to do with it, so the Agent harness can read the same stream the UI does.
package capture

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"
)

// MaxBodyBytes bounds what the proxy keeps of one direction of a message, so a
// large download cannot grow the app without limit.
const MaxBodyBytes = 2 << 20

// Traffic is one request and its response, as the proxy saw them.
type Traffic struct {
	ID              string    `json:"id"`
	Sequence        uint64    `json:"sequence"`
	At              time.Time `json:"at"`
	Method          string    `json:"method"`
	URL             string    `json:"url"`
	Host            string    `json:"host"`
	Scheme          string    `json:"scheme"`
	RequestHTTP     string    `json:"requestHttp"`
	Status          int       `json:"status"`
	StatusText      string    `json:"statusText"`
	ResponseHTTP    string    `json:"responseHttp"`
	DurationMS      int64     `json:"durationMs"`
	RequestSize     int       `json:"requestSize"`
	Size            int       `json:"size"`
	Encoding        string    `json:"encoding"`
	RequestEncoding string    `json:"requestEncoding"`
	ContentType     string    `json:"contentType"`
	Truncated       bool      `json:"truncated"`
	Error           string    `json:"error,omitempty"`
}

// Settings is the proxy's current configuration, as the UI reports it.
type Settings struct {
	Running  bool   `json:"running"`
	Addr     string `json:"addr"`
	Port     int    `json:"port"`
	CACert   string `json:"caCert,omitempty"`
	Captured int    `json:"captured"`
	Error    string `json:"error,omitempty"`
}

// Options configure a proxy before it starts.
type Options struct {
	// OnCertificate receives only the locally generated leaf certificate, before
	// the client TLS handshake. Embedded browsers use it to pin Acro's certificate
	// for each requested host, including third-party HTTPS subresources.
	OnCertificate func(host string, der []byte)

	// Port is the listening port on 127.0.0.1; 0 picks a free one.
	Port int
	// CADir is where the certificate authority is kept, created on first use.
	CADir string
	// OnTraffic receives every exchange, in the order the proxy finished it.
	OnTraffic func(Traffic)
	// OnState reports a start, stop or failure to the UI.
	OnState func(Settings)
	// OnReset clears retained history within the same boundary as record delivery.
	OnReset func()
	// UpstreamTLS, when set, decides how the proxy verifies the sites it
	// forwards to. Nil keeps the system roots, which is what a person expects;
	// a test or an app pinning its own roots sets it.
	UpstreamTLS *tls.Config
}

// Proxy owns one listener generation at a time. lifecycle serializes changes;
// mu protects snapshots without holding a lock while notifying subscribers.
type Proxy struct {
	opts      Options
	ca        *authority
	lifecycle sync.Mutex
	mu        sync.Mutex
	run       *proxyRun
	settings  Settings
	count     atomic.Int64
	records   sync.Mutex
	sequence  uint64 // Protected by records; never reset when clearing history.
	client    *http.Client
}

type proxyRun struct {
	server   *http.Server
	listener *splitListener
	cancel   context.CancelFunc
}

type runContextKey struct{}

func New(opts Options) (*Proxy, error) {
	if opts.Port < 0 || opts.Port > 65535 {
		return nil, fmt.Errorf("port must be between 0 and 65535")
	}
	ca, err := loadAuthority(opts.CADir)
	if err != nil {
		return nil, err
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.DisableCompression = true
	transport.ResponseHeaderTimeout = 30 * time.Second
	upstream := &tls.Config{}
	if opts.UpstreamTLS != nil {
		upstream = opts.UpstreamTLS.Clone()
	}
	upstream.NextProtos = []string{"http/1.1"}
	transport.TLSClientConfig = upstream
	transport.ForceAttemptHTTP2 = false
	p := &Proxy{opts: opts, ca: ca, settings: Settings{Port: opts.Port, CACert: ca.PEM()}}
	p.client = &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return p, nil
}

func (p *Proxy) CACert() string { return p.ca.PEM() }
func (p *Proxy) Settings() Settings {
	p.mu.Lock()
	defer p.mu.Unlock()
	s := p.settings
	s.Captured = int(p.count.Load())
	return s
}

func (p *Proxy) Start() (Settings, error) {
	p.lifecycle.Lock()
	p.mu.Lock()
	if p.run != nil {
		s := p.settings
		s.Captured = int(p.count.Load())
		p.mu.Unlock()
		p.lifecycle.Unlock()
		return s, nil
	}
	p.mu.Unlock()
	listener, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(p.opts.Port)))
	if err != nil {
		p.mu.Lock()
		p.settings.Running = false
		p.settings.Error = err.Error()
		p.mu.Unlock()
		p.lifecycle.Unlock()
		p.state()
		return p.Settings(), err
	}
	ctx, cancel := context.WithCancel(context.Background())
	ctx = context.WithValue(ctx, runContextKey{}, ctx)
	split := newSplitListener(ctx, listener, p.serveSOCKS)
	server := &http.Server{Handler: p, ReadHeaderTimeout: 30 * time.Second, IdleTimeout: 90 * time.Second, BaseContext: func(net.Listener) context.Context { return ctx }}
	run := &proxyRun{server: server, listener: split, cancel: cancel}
	p.mu.Lock()
	p.run = run
	p.settings = Settings{Running: true, Addr: listener.Addr().String(), Port: listener.Addr().(*net.TCPAddr).Port, CACert: p.ca.PEM(), Captured: int(p.count.Load())}
	s := p.settings
	p.mu.Unlock()
	go func() {
		if err := server.Serve(split); err != nil {
			p.lifecycle.Lock()
			p.mu.Lock()
			current := p.run == run
			if current {
				p.run = nil
				p.settings.Running = false
				p.settings.Error = err.Error()
			}
			p.mu.Unlock()
			cancel()
			_ = split.Close()
			p.lifecycle.Unlock()
			if current {
				p.state()
			}
		}
	}()
	p.lifecycle.Unlock()
	p.state()
	return s, nil
}

func (p *Proxy) Stop() error {
	p.lifecycle.Lock()
	p.mu.Lock()
	run := p.run
	p.run = nil
	p.settings.Running = false
	p.mu.Unlock()
	var err error
	if run != nil {
		run.cancel()
		err = run.server.Close()
		_ = run.listener.Close()
		p.client.CloseIdleConnections()
	}
	p.lifecycle.Unlock()
	p.state()
	return err
}

func (p *Proxy) Reset() {
	p.records.Lock()
	p.count.Store(0)
	if p.opts.OnReset != nil {
		p.opts.OnReset()
	}
	p.records.Unlock()
	p.state()
}
func (p *Proxy) state() {
	if p.opts.OnState != nil {
		p.opts.OnState(p.Settings())
	}
}

func (p *Proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Context().Err() != nil {
		return
	}
	if r.Method == http.MethodConnect {
		p.tunnel(w, r)
		return
	}
	if !r.URL.IsAbs() || r.URL.Host == "" || (r.URL.Scheme != "http" && r.URL.Scheme != "https") {
		http.Error(w, "Acro proxy expects an absolute HTTP(S) request", http.StatusBadRequest)
		return
	}
	p.forward(w, r)
}

// forward streams both directions unchanged. Only the retained copies are capped.
func (p *Proxy) forward(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	requestBody, responseBody := &bodyCapture{}, &bodyCapture{}
	original := r.Clone(r.Context())
	traffic := Traffic{ID: newID(), At: start, Method: r.Method, URL: r.URL.String(), Host: r.URL.Host, Scheme: r.URL.Scheme, Encoding: "utf-8"}
	var response *http.Response
	recorded := false
	finish := func() {
		if recorded {
			return
		}
		recorded = true
		requestData, requestSize := requestBody.snapshot()
		responseData, responseSize := responseBody.snapshot()
		traffic.RequestSize = requestSize
		traffic.Size = responseSize
		traffic.Truncated = requestSize > len(requestData) || responseSize > len(responseData)
		traffic.RequestHTTP = dumpRequest(original, requestData)
		traffic.RequestEncoding = "utf-8"
		if !utf8.Valid(requestData) {
			traffic.RequestEncoding = "base64"
		}
		if response != nil {
			traffic.ResponseHTTP = dumpResponse(response, responseData)
		}
		if !utf8.Valid(responseData) {
			traffic.Encoding = "base64"
		}
		traffic.DurationMS = time.Since(start).Milliseconds()
		p.record(traffic)
	}
	defer finish()
	out := r.Clone(r.Context())
	out.RequestURI = ""
	out.Close = false
	out.TransferEncoding = nil
	if r.Body != nil && r.Body != http.NoBody {
		out.Body = &recordingBody{ReadCloser: r.Body, capture: requestBody}
	}
	upgrade := r.Header.Get("Upgrade")
	upgradeRequested := upgrade != "" && headerToken(r.Header, "Connection", "upgrade")
	removeHopHeaders(out.Header)
	if upgradeRequested {
		out.Header.Set("Connection", "Upgrade")
		out.Header.Set("Upgrade", upgrade)
	}
	resp, err := p.client.Do(out)
	if err != nil {
		traffic.Error = err.Error()
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	response = resp
	traffic.Status, traffic.StatusText, traffic.ContentType = resp.StatusCode, http.StatusText(resp.StatusCode), resp.Header.Get("Content-Type")
	if resp.StatusCode == http.StatusSwitchingProtocols {
		if !upgradeRequested || !strings.EqualFold(resp.Header.Get("Upgrade"), upgrade) {
			traffic.Error = "Unexpected protocol upgrade"
			http.Error(w, traffic.Error, http.StatusBadGateway)
			return
		}
		if err := relayUpgrade(w, r, resp, finish); err != nil {
			traffic.Error = err.Error()
		}
		return
	}

	headers := resp.Header.Clone()
	removeHopHeaders(headers)
	copyHeaders(w.Header(), headers)
	for name := range resp.Trailer {
		w.Header().Add("Trailer", name)
	}
	w.WriteHeader(resp.StatusCode)
	// Flush per write so event streams do not wait for the upstream to end.
	writer := &flushingWriter{writer: w, controller: http.NewResponseController(w)}
	_, err = io.Copy(writer, io.TeeReader(resp.Body, responseBody))
	if err != nil {
		traffic.Error = err.Error()
		panic(http.ErrAbortHandler)
	}
	for name, values := range resp.Trailer {
		w.Header()[http.TrailerPrefix+name] = values
	}
}

type flushingWriter struct {
	writer     io.Writer
	controller *http.ResponseController
}

func (w *flushingWriter) Write(b []byte) (int, error) {
	n, err := w.writer.Write(b)
	if err == nil {
		err = w.controller.Flush()
		if errors.Is(err, http.ErrNotSupported) {
			err = nil
		}
	}
	return n, err
}

type bodyCapture struct {
	mu   sync.Mutex
	data []byte
	size int
}

func (b *bodyCapture) Write(data []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.size += len(data)
	if remaining := MaxBodyBytes - len(b.data); remaining > 0 {
		b.data = append(b.data, data[:min(remaining, len(data))]...)
	}
	return len(data), nil
}
func (b *bodyCapture) snapshot() ([]byte, int) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]byte(nil), b.data...), b.size
}

type recordingBody struct {
	io.ReadCloser
	capture *bodyCapture
}

func (b *recordingBody) Read(data []byte) (int, error) {
	n, err := b.ReadCloser.Read(data)
	_, _ = b.capture.Write(data[:n])
	return n, err
}

func (p *Proxy) tunnel(w http.ResponseWriter, r *http.Request) {
	target := r.URL.Host
	if target == "" {
		target = r.Host
	}
	if target == "" {
		http.Error(w, "CONNECT needs a target host", http.StatusBadRequest)
		return
	}
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "CONNECT requires HTTP/1.1", http.StatusBadRequest)
		return
	}
	conn, buffer, err := hijacker.Hijack()
	if err != nil {
		return
	}
	defer conn.Close()
	if _, err = io.WriteString(conn, "HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
		return
	}
	// A hijacked connection outlives its CONNECT request context.
	ctx := r.Context()
	if parent, ok := ctx.Value(runContextKey{}).(context.Context); ok {
		ctx = parent
	}
	p.tunnelTLS(ctx, buffer.Reader, conn, target)
}

func (p *Proxy) tunnelTLS(ctx context.Context, reader *bufio.Reader, conn net.Conn, target string) {
	cfg, err := p.ca.tlsConfig(target)
	if err != nil {
		return
	}
	if p.opts.OnCertificate != nil {
		p.opts.OnCertificate(canonicalHost(target), cfg.Certificates[0].Certificate[0])
	}
	tlsConn := tls.Server(&readerConn{Conn: conn, r: reader}, cfg)
	defer tlsConn.Close()
	_ = conn.SetDeadline(time.Now().Add(30 * time.Second))
	if err = tlsConn.HandshakeContext(ctx); err != nil {
		if ctx.Err() == nil {
			p.record(Traffic{ID: newID(), At: time.Now(), Method: "CONNECT", URL: "https://" + target, Host: target, Scheme: "https", Encoding: "utf-8", Error: "TLS handshake failed: " + err.Error()})
		}
		return
	}
	_ = conn.SetDeadline(time.Time{})
	p.serveTunnel(ctx, tlsConn, target, "https")
}

func (p *Proxy) serveTunnel(ctx context.Context, conn net.Conn, target, scheme string) {
	listener := newSingleListener(conn)
	defer listener.Close()
	server := &http.Server{ReadHeaderTimeout: 30 * time.Second, IdleTimeout: 90 * time.Second, BaseContext: func(net.Listener) context.Context { return ctx }, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The negotiated destination owns this tunnel; an absolute URI must not redirect it elsewhere.
		if r.Method == http.MethodConnect {
			http.Error(w, "Nested CONNECT is not supported", http.StatusBadRequest)
			return
		}
		r.URL.Scheme, r.URL.Host = scheme, target
		p.forward(w, r)
	})}
	defer server.Close()
	_ = server.Serve(listener)
}

func (p *Proxy) record(t Traffic) {
	p.records.Lock()
	defer p.records.Unlock()
	p.count.Add(1)
	p.sequence++
	t.Sequence = p.sequence
	if p.opts.OnTraffic != nil {
		p.opts.OnTraffic(t)
	}
}

func dumpRequest(r *http.Request, body []byte) string {
	clone := r.Clone(r.Context())
	clone.Body = nil
	// DumpRequest omits Host for absolute-form proxy requests. Render the
	// origin form so inspection and replay retain the client's explicit Host.
	clone.RequestURI = ""
	clone.URL.Scheme = ""
	clone.URL.Host = ""
	head, err := httputil.DumpRequest(clone, false)
	if err != nil {
		return ""
	}
	return string(head) + displayBody(body)
}
func dumpResponse(r *http.Response, body []byte) string {
	clone := new(http.Response)
	*clone = *r
	clone.Header = r.Header.Clone()
	clone.Body = nil
	head, err := httputil.DumpResponse(clone, false)
	if err != nil {
		return ""
	}
	return string(head) + displayBody(body)
}
func displayBody(body []byte) string {
	if !utf8.Valid(body) {
		return base64.StdEncoding.EncodeToString(body)
	}
	return string(body)
}

func removeHopHeaders(h http.Header) {
	for _, value := range h.Values("Connection") {
		for _, name := range strings.Split(value, ",") {
			h.Del(strings.TrimSpace(name))
		}
	}
	for _, name := range []string{"Connection", "Proxy-Connection", "Keep-Alive", "Proxy-Authenticate", "Proxy-Authorization", "Te", "Trailer", "Transfer-Encoding", "Upgrade"} {
		h.Del(name)
	}
}
func copyHeaders(dst, src http.Header) {
	for name, values := range src {
		dst[name] = append([]string(nil), values...)
	}
}
func newID() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return base64.RawURLEncoding.EncodeToString(b[:])
}
