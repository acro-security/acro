package captureapp

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"
	"time"
)

func TestServiceRestartPreservesSessionAndCertificate(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	s := NewService()
	if err := s.Configure(0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	settings, err := s.Start()
	if err != nil {
		t.Fatal(err)
	}
	cert, err := s.Certificate()
	if err != nil {
		t.Fatal(err)
	}
	if err = s.Configure(12345); err == nil {
		t.Fatal("cannot change the port of a running listener")
	}
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, "ok") }))
	defer target.Close()
	u, _ := url.Parse("http://" + settings.Addr)
	transport := &http.Transport{Proxy: http.ProxyURL(u)}
	defer transport.CloseIdleConnections()
	resp, err := (&http.Client{Transport: transport, Timeout: time.Second}).Get(target.URL)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	deadline := time.After(time.Second)
	for len(s.History()) == 0 {
		select {
		case <-deadline:
			t.Fatal("capture history missing")
		case <-time.After(time.Millisecond):
		}
	}
	stopped, err := s.Stop()
	if err != nil {
		t.Fatal(err)
	}
	if stopped.Running || s.Status().Running {
		t.Fatal("stop did not update status")
	}
	restarted, err := s.Start()
	if err != nil {
		t.Fatal(err)
	}
	if !restarted.Running || restarted.Captured != 1 || len(s.History()) != 1 || restarted.CACert != cert {
		t.Fatal("restart lost the capture session")
	}
	s.Clear()
	if s.Status().Captured != 0 || len(s.History()) != 0 {
		t.Fatal("clear did not reset session")
	}
}

func TestConcurrentServiceStartStop(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	s := NewService()
	_ = s.Configure(0)
	t.Cleanup(func() { _ = s.Close() })
	var workers sync.WaitGroup
	for range 12 {
		workers.Go(func() {
			for range 4 {
				if _, err := s.Start(); err != nil {
					t.Error(err)
				}
				_ = s.Status()
				if _, err := s.Stop(); err != nil {
					t.Error(err)
				}
			}
		})
	}
	workers.Wait()
	if _, err := s.Stop(); err != nil {
		t.Fatal(err)
	}
	if s.Status().Running {
		t.Fatal("listener leaked after concurrent stop")
	}
}
