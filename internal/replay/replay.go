// Package replay owns HTTP execution independently of the desktop transport.
// The future agent harness can call Executor with the same inputs as the UI.
package replay

import (
	"bufio"
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const MaxResponseBytes = 2 * 1024 * 1024

type Input struct {
	Target          string `json:"target"`
	Raw             string `json:"raw"`
	FollowRedirects bool   `json:"followRedirects"`
	TimeoutSeconds  int    `json:"timeoutSeconds"`
}

type Header struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

type Result struct {
	Status     int      `json:"status"`
	StatusText string   `json:"statusText"`
	Protocol   string   `json:"protocol"`
	Headers    []Header `json:"headers"`
	Body       string   `json:"body"`
	Encoding   string   `json:"encoding"`
	DurationMS int64    `json:"durationMs"`
	Size       int      `json:"size"`
	Truncated  bool     `json:"truncated"`
	URL        string   `json:"url"`
}

// Executor is the execution boundary shared by human and future agent callers.
type Executor interface {
	Execute(context.Context, Input) (Result, error)
}

type Engine struct{}

func (Engine) Execute(ctx context.Context, in Input) (Result, error) {
	target, err := url.Parse(in.Target)
	if err != nil || target.Host == "" || target.User != nil || target.Fragment != "" ||
		(target.Scheme != "http" && target.Scheme != "https") {
		return Result{}, fmt.Errorf("target must be an absolute HTTP(S) URL without credentials or a fragment")
	}
	if (target.Path != "" && target.Path != "/") || target.RawQuery != "" {
		return Result{}, fmt.Errorf("target must contain only the origin; put the path and query in the request line")
	}
	// Normalize header line endings only; preserve body bytes. The editor
	// changes bodies freely, so framing is recalculated rather than trusted.
	header, body := in.Raw, ""
	crlf, lf := strings.Index(header, "\r\n\r\n"), strings.Index(header, "\n\n")
	if lf >= 0 && (crlf < 0 || lf < crlf) {
		header, body = header[:lf], header[lf+2:]
	} else if crlf >= 0 {
		header, body = header[:crlf], header[crlf+4:]
	}
	lines := strings.Split(strings.ReplaceAll(header, "\r\n", "\n"), "\n")
	if len(lines) == 0 || strings.TrimSpace(lines[0]) == "" {
		return Result{}, fmt.Errorf("request line is required")
	}
	clean := []string{lines[0]}
	for _, line := range lines[1:] {
		name, _, _ := strings.Cut(line, ":")
		if strings.EqualFold(name, "Transfer-Encoding") {
			return Result{}, fmt.Errorf("Transfer-Encoding is not supported in the editor; provide a decoded body")
		}
		if !strings.EqualFold(name, "Content-Length") {
			clean = append(clean, line)
		}
	}
	if body != "" {
		clean = append(clean, "Content-Length: "+strconv.Itoa(len(body)))
	}
	raw := strings.Join(clean, "\r\n") + "\r\n\r\n" + body
	req, err := http.ReadRequest(bufio.NewReader(strings.NewReader(raw)))
	if err != nil {
		return Result{}, fmt.Errorf("invalid request: %w", err)
	}
	defer req.Body.Close()
	if req.URL.IsAbs() || req.URL.Host != "" || !strings.HasPrefix(req.RequestURI, "/") {
		return Result{}, fmt.Errorf("request line must use an origin-form path beginning with /")
	}
	seconds := in.TimeoutSeconds
	if seconds < 1 || seconds > 120 {
		seconds = 30
	}
	ctx, cancel := context.WithTimeout(ctx, time.Duration(seconds)*time.Second)
	defer cancel()
	req = req.WithContext(ctx)
	if body != "" {
		// net/http needs GetBody to replay a body across 307/308 redirects.
		req.GetBody = func() (io.ReadCloser, error) { return io.NopCloser(strings.NewReader(body)), nil }
	}
	req.URL.Scheme, req.URL.Host = target.Scheme, target.Host
	req.RequestURI = ""
	if req.Host == "" {
		req.Host = target.Host
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport}
	if !in.FollowRedirects {
		client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	}
	start := time.Now()
	resp, err := client.Do(req)
	if err != nil {
		return Result{}, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(resp.Body, MaxResponseBytes+1))
	if err != nil {
		return Result{}, fmt.Errorf("reading response failed: %w", err)
	}
	truncated := len(responseBody) > MaxResponseBytes
	if truncated {
		responseBody = responseBody[:MaxResponseBytes]
	}
	result := Result{Status: resp.StatusCode, StatusText: http.StatusText(resp.StatusCode), Protocol: resp.Proto,
		Body: string(responseBody), Encoding: "utf-8", DurationMS: time.Since(start).Milliseconds(), Size: len(responseBody),
		Truncated: truncated, URL: resp.Request.URL.String(), Headers: []Header{}}
	if !utf8.Valid(responseBody) {
		result.Body = base64.StdEncoding.EncodeToString(responseBody)
		result.Encoding = "base64"
	}
	for name, values := range resp.Header {
		for _, value := range values {
			result.Headers = append(result.Headers, Header{name, value})
		}
	}
	sort.SliceStable(result.Headers, func(i, j int) bool { return result.Headers[i].Name < result.Headers[j].Name })
	return result, nil
}

// Service is the IPC surface the web frontend calls. mygo binds it as
// `Service` and generates the matching TypeScript client.
type Service struct{ engine Engine }

func NewService() *Service { return &Service{} }

// Send replays input and returns the response, or the error that stopped it.
func (s *Service) Send(ctx context.Context, input Input) (Result, error) {
	return s.engine.Execute(ctx, input)
}
