package replay

import (
	"context"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestReplayPreservesBodyAndRecalculatesLength(t *testing.T) {
	body := "{\"text\":\"你好\"}\r\n\r\nsecond line\n\nthird line"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got, _ := io.ReadAll(r.Body)
		if string(got) != body {
			t.Errorf("body = %q, want %q", got, body)
		}
		if r.Method != "POST" || r.URL.RequestURI() != "/echo?q=one%20two" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL)
		}
		if r.Host != "virtual.example" {
			t.Errorf("Host = %q", r.Host)
		}
		w.Header().Add("X-Test", "first")
		w.Header().Add("X-Test", "second")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write(got)
	}))
	defer server.Close()
	result, err := (Engine{}).Execute(context.Background(), Input{Target: server.URL,
		Raw: "POST /echo?q=one%20two HTTP/1.1\nHost: virtual.example\nContent-Length: 1\n\n" + body})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != 201 || result.Body != body || result.Size != len(body) {
		t.Fatalf("unexpected result: %+v", result)
	}
	count := 0
	for _, h := range result.Headers {
		if h.Name == "X-Test" {
			count++
		}
	}
	if count != 2 {
		t.Fatalf("expected repeated headers, got %d", count)
	}
}

func TestRedirectPolicy(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/start" {
			http.Redirect(w, r, "/done", http.StatusFound)
			return
		}
		_, _ = w.Write([]byte("done"))
	}))
	defer server.Close()
	for _, follow := range []bool{false, true} {
		result, err := (Engine{}).Execute(context.Background(), Input{
			Target:          server.URL,
			Raw:             "GET /start HTTP/1.1\nHost: localhost\n\n",
			FollowRedirects: follow,
		})
		if err != nil {
			t.Fatal(err)
		}
		want := 302
		if follow {
			want = 200
		}
		if result.Status != want {
			t.Errorf("follow=%v: status=%d, want=%d", follow, result.Status, want)
		}
	}
}

func TestRedirect307PreservesBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/start" {
			http.Redirect(w, r, "/done", http.StatusTemporaryRedirect)
			return
		}
		body, _ := io.ReadAll(r.Body)
		if r.Method != "POST" || string(body) != "payload" {
			t.Errorf("redirect lost method or body: %s %q", r.Method, body)
		}
		_, _ = w.Write(body)
	}))
	defer server.Close()
	result, err := (Engine{}).Execute(context.Background(), Input{Target: server.URL,
		Raw: "POST /start HTTP/1.1\nHost: localhost\n\npayload", FollowRedirects: true})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != 200 || result.Body != "payload" {
		t.Fatalf("unexpected redirect result: %+v", result)
	}
}

func TestCancellation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() }))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	_, err := (Engine{}).Execute(ctx, Input{Target: server.URL, Raw: "GET / HTTP/1.1\nHost: localhost\n\n"})
	if err == nil || !strings.Contains(err.Error(), "context deadline exceeded") {
		t.Fatalf("expected cancellation, got %v", err)
	}
}

func TestBinaryAndResponseLimit(t *testing.T) {
	for _, data := range [][]byte{{0xff, 0x00, 0xfe}, []byte(strings.Repeat("x", MaxResponseBytes+10))} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write(data)
		}))
		result, err := (Engine{}).Execute(context.Background(), Input{
			Target: server.URL,
			Raw:    "GET / HTTP/1.1\nHost: localhost\n\n",
		})
		server.Close()
		if err != nil {
			t.Fatal(err)
		}
		if len(data) < MaxResponseBytes {
			if result.Encoding != "base64" || result.Body != base64.StdEncoding.EncodeToString(data) {
				t.Fatalf("invalid binary result: %+v", result)
			}
		} else if !result.Truncated || result.Size != MaxResponseBytes {
			t.Fatalf("limit not enforced: size=%d", result.Size)
		}
	}
}

func TestInvalidInputs(t *testing.T) {
	for _, in := range []Input{
		{Target: "file:///etc/passwd"},
		{Target: "https://user:pass@example.com"},
		{Target: "https://example.com/ignored-path"},
		{Target: "https://example.com", Raw: "invalid"},
		{Target: "https://example.com", Raw: "GET https://other.example/ HTTP/1.1\nHost: other.example\n\n"},
		{Target: "https://example.com", Raw: "POST / HTTP/1.1\nHost: example.com\nTransfer-Encoding: chunked\n\n0\n\n"},
	} {
		if _, err := (Engine{}).Execute(context.Background(), in); err == nil {
			t.Errorf("accepted invalid input: %+v", in)
		}
	}
}
