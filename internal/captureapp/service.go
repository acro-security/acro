// Package captureapp binds internal/capture to the window: it owns the proxy's
// lifetime, streams what it captures to the page as it happens, and keeps the
// resent history the page shows.
package captureapp

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"acro/internal/capture"
	"github.com/egoist/mygo"
)

// Traffic is sent to the page as the proxy records it, so the list grows
// without polling.
var Traffic = mygo.NewEvent[capture.Traffic]("traffic")

// State reports the proxy starting, stopping or failing.
var State = mygo.NewEvent[capture.Settings]("capture:state")

// Service is the IPC surface for capturing. It owns one proxy for the app's
// life, so starting and stopping is cheap and the certificate is stable.
type Service struct {
	lifecycle     sync.Mutex
	mu            sync.Mutex
	proxy         *capture.Proxy
	port          int
	recent        []capture.Traffic
	onCertificate func(string, []byte)
}

// NewService prepares the proxy without listening yet. The certificate
// authority is created on first use under the app's user data directory.
func NewService(onCertificate ...func(string, []byte)) *Service {
	s := &Service{port: 8081}
	if len(onCertificate) > 0 {
		s.onCertificate = onCertificate[0]
	}
	return s
}

// Configure sets the port the proxy listens on.
func (s *Service) Configure(port int) error {
	if port < 0 || port > 65535 {
		return fmt.Errorf("port must be between 0 and 65535")
	}
	s.lifecycle.Lock()
	defer s.lifecycle.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.proxy != nil && s.proxy.Settings().Running {
		return fmt.Errorf("stop the proxy before changing its port")
	}
	if s.port != port {
		s.proxy = nil
	}
	s.port = port
	return nil
}

// Start listens on the configured port and streams what it captures.
func (s *Service) Start() (capture.Settings, error) {
	s.lifecycle.Lock()
	defer s.lifecycle.Unlock()
	s.mu.Lock()
	current := s.proxy
	s.mu.Unlock()
	if current != nil {
		return current.Start()
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		return capture.Settings{}, err
	}
	proxy, err := capture.New(capture.Options{
		Port:          s.port,
		OnCertificate: s.onCertificate,
		CADir:         filepath.Join(dir, "acro", "proxy"),
		OnTraffic: func(t capture.Traffic) {
			s.remember(t)
			_ = Traffic.Broadcast(t)
		},
		OnState: func(settings capture.Settings) {
			_ = State.Broadcast(settings)
		},
		OnReset: func() { s.mu.Lock(); s.recent = nil; s.mu.Unlock() },
	})
	if err != nil {
		return capture.Settings{}, err
	}
	s.mu.Lock()
	s.proxy = proxy
	s.mu.Unlock()
	return proxy.Start()
}

// Stop releases the port and every tunnel.
func (s *Service) Stop() (capture.Settings, error) {
	s.lifecycle.Lock()
	defer s.lifecycle.Unlock()
	s.mu.Lock()
	proxy := s.proxy
	port := s.port
	s.mu.Unlock()
	if proxy == nil {
		return capture.Settings{Port: port}, nil
	}
	if err := proxy.Stop(); err != nil {
		return proxy.Settings(), err
	}
	return proxy.Settings(), nil
}

// Status reports whether the proxy is listening and how much it captured.
func (s *Service) Status() capture.Settings {
	s.mu.Lock()
	proxy := s.proxy
	port := s.port
	s.mu.Unlock()
	if proxy == nil {
		return capture.Settings{Port: port}
	}
	return proxy.Settings()
}

// Traffic returns the exchanges the proxy captured in this session, so a page
// that reloads or opens late does not lose what came before it.
func (s *Service) History() []capture.Traffic {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]capture.Traffic, len(s.recent))
	copy(out, s.recent)
	return out
}

// Clear forgets the captured exchanges, in the page and in the proxy's count.
func (s *Service) Clear() {
	s.lifecycle.Lock()
	defer s.lifecycle.Unlock()
	s.mu.Lock()
	proxy := s.proxy
	s.mu.Unlock()
	if proxy != nil {
		proxy.Reset()
	} else {
		s.mu.Lock()
		s.recent = nil
		s.mu.Unlock()
	}
}

// Certificate returns the root certificate a client installs to trust the
// proxy, so the page can offer it as a download.
func (s *Service) Certificate() (string, error) {
	s.mu.Lock()
	proxy := s.proxy
	s.mu.Unlock()
	if proxy == nil {
		return "", fmt.Errorf("start the proxy first")
	}
	return proxy.CACert(), nil
}

// remember keeps the newest exchanges, bounded as the history is.
func (s *Service) remember(t capture.Traffic) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.recent = append(s.recent, t)
	if len(s.recent) > 500 {
		s.recent = s.recent[len(s.recent)-500:]
	}
}

// Close stops the proxy as the app exits.
func (s *Service) Close() error {
	_, err := s.Stop()
	return err
}
