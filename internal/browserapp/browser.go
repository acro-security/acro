package browserapp

import (
	"context"
	"crypto/rand"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"acro/internal/capture"
	"acro/internal/vault"
	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

//go:embed fill.js
var fillScript string

type Tab struct {
	ID        string `json:"id"`
	ProjectID string `json:"projectId"`
	URL       string `json:"url"`
	Title     string `json:"title"`
	Loading   bool   `json:"loading"`
	Back      bool   `json:"back"`
	Forward   bool   `json:"forward"`
	Error     string `json:"error"`
}
type State struct {
	Tabs       []Tab  `json:"tabs"`
	SelectedID string `json:"selectedId"`
}
type OpenInput struct {
	URL       string `json:"url"`
	ProjectID string `json:"projectId"`
}
type Viewport struct {
	TabID        string  `json:"tabId"`
	Visible      bool    `json:"visible"`
	X            float32 `json:"x"`
	Y            float32 `json:"y"`
	Width        float32 `json:"width"`
	Height       float32 `json:"height"`
	ClientWidth  float32 `json:"clientWidth"`
	ClientHeight float32 `json:"clientHeight"`
}
type FillInput struct {
	TabID        string `json:"tabId"`
	CredentialID string `json:"credentialId"`
}
type page struct {
	info Tab
	view *mygo.WebView
}

var Changed = mygo.NewEvent[State]("browser:state")

// Host is owned by the native main thread. It is never bound to JavaScript.
type Host struct {
	win       *mygo.Window
	shell     *mygo.WebView
	pages     []*page
	selected  string
	viewport  Viewport
	sessions  map[string]*mygo.Session
	network   *browserNetwork
	proxy     capture.Settings
	openPopup func(OpenInput)
}

func NewHost() *Host { return &Host{sessions: map[string]*mygo.Session{}} }
func (h *Host) Attach(w *mygo.Window) error {
	h.win = w
	v, err := w.NewWebView(mygo.WebViewOptions{URL: "/"})
	if err != nil {
		return err
	}
	h.shell = v
	w.OnClosed(func() {
		if h.network != nil {
			h.network.close()
		}
	})
	v.Page().OnDidNavigate(func(string) { h.viewport.Visible = false; w.Invalidate() })
	w.Invalidate()
	return nil
}
func (h *Host) View(c *ui.Context) {
	ui.Column(c).Fill().Children(func() {
		if h.shell != nil {
			ui.WebView(c, h.shell).Grow(1)
		}
		v := h.viewport
		if v.Visible && v.Width > 0 && v.Height > 0 {
			if p := h.find(v.TabID); p != nil {
				ui.WebView(c, p.view).Absolute().Left(v.X).Top(v.Y).Width(v.Width).Height(v.Height)
			}
		}
	})
}
func (h *Host) find(id string) *page {
	for _, p := range h.pages {
		if p.info.ID == id {
			return p
		}
	}
	return nil
}
func (h *Host) snapshot() State {
	s := State{Tabs: []Tab{}, SelectedID: h.selected}
	for _, p := range h.pages {
		s.Tabs = append(s.Tabs, p.info)
	}
	return s
}
func (h *Host) changed() {
	_ = Changed.Broadcast(h.snapshot())
	if h.win != nil {
		h.win.Invalidate()
	}
}
func (h *Host) refresh(p *page) {
	if h.find(p.info.ID) == nil {
		return
	}
	pg := p.view.Page()
	p.info.URL = pg.URL()
	p.info.Loading = pg.IsLoading()
	p.info.Back = pg.CanGoBack()
	p.info.Forward = pg.CanGoForward()
	h.changed()
}
func (h *Host) open(in OpenInput) (State, error) {
	if h.win == nil {
		return State{}, errors.New("The desktop browser is not ready")
	}
	if len(h.pages) >= 20 {
		return h.snapshot(), errors.New("Close a browser tab before opening another (maximum 20)")
	}
	raw := strings.TrimSpace(in.URL)
	if !strings.Contains(raw, "://") {
		raw = "https://" + raw
	}
	if _, err := vault.Origin(raw); err != nil {
		return h.snapshot(), err
	}
	session := h.sessions[in.ProjectID]
	if session == nil {
		session = mygo.NewSession("browser:" + in.ProjectID)
		h.sessions[in.ProjectID] = session
	}
	if h.network == nil {
		network, err := newBrowserNetwork()
		if err != nil {
			return h.snapshot(), err
		}
		h.network = network
	}
	before := h.network.widgets(h.win.NativeHandle())
	// A blank page cannot issue target requests before the proxy is configured.
	v, err := h.win.NewWebView(mygo.WebViewOptions{URL: "about:blank", Page: mygo.PageOptions{Session: session, Untrusted: true}})
	if err != nil {
		return h.snapshot(), errors.New("Cannot create the browser WebView")
	}
	if err = h.network.configure(h.win.NativeHandle(), before, h.proxy.Addr, h.proxy.CACert); err != nil {
		v.Destroy()
		return h.snapshot(), err
	}
	var id [16]byte
	_, _ = rand.Read(id[:])
	p := &page{info: Tab{ID: hex.EncodeToString(id[:]), ProjectID: in.ProjectID, URL: raw, Title: raw, Loading: true}, view: v}
	h.pages = append(h.pages, p)
	h.selected = p.info.ID
	pg := v.Page()
	pg.OnWillNavigate(func(e *mygo.NavigateEvent) {
		if _, err := vault.Origin(e.URL); err != nil {
			e.PreventDefault()
		}
	})
	pg.SetWindowOpenHandler(func(req mygo.WindowOpenRequest) *mygo.WindowOptions {
		if req.UserInitiated {
			if h.openPopup != nil {
				h.openPopup(OpenInput{URL: req.URL, ProjectID: in.ProjectID})
			}
		}
		return nil
	})
	pg.OnDidNavigate(func(string) { p.info.Error = ""; h.refresh(p) })
	pg.OnPageTitleUpdated(func(e *mygo.TitleEvent) { p.info.Title = e.Title; h.changed() })
	pg.OnDidFinishLoad(func() { p.info.Loading = false; h.refresh(p) })
	pg.OnDidFailLoad(func(e *mygo.LoadError) {
		p.info.Error = fmt.Sprintf("Page could not be loaded: %s (%d)", e.Description, e.Code)
		p.info.Loading = false
		h.changed()
	})
	if err = pg.LoadURL(raw); err != nil {
		p.info.Error = "Page could not be loaded"
	}
	h.changed()
	return h.snapshot(), nil
}

// Service exposes browser operations, but never a credential getter or arbitrary script evaluation.
type Service struct {
	host    *Host
	vault   *vault.Manager
	capture captureController
}

type captureController interface {
	Start() (capture.Settings, error)
}

func NewService(h *Host, v *vault.Manager, c captureController) *Service {
	s := &Service{host: h, vault: v, capture: c}
	h.openPopup = func(in OpenInput) { go func() { _, _ = s.Open(in) }() }
	return s
}

// TrustProxyCertificate runs on the native thread and never installs a system CA.
func (h *Host) TrustProxyCertificate(host string, der []byte) {
	mygo.RunOnMain(func() {
		if h.network != nil {
			h.network.trust(host, der)
		}
	})
}
func (s *Service) ensureCapture() (capture.Settings, error) {
	if s.capture == nil {
		return capture.Settings{}, errors.New("Browser capture is not configured")
	}
	state, err := s.capture.Start()
	if err != nil {
		return state, err
	}
	if !state.Running || state.Addr == "" {
		return state, errors.New("The browser capture proxy is not running")
	}
	return state, nil
}
func (s *Service) Status() State {
	var out State
	mygo.RunOnMain(func() { out = s.host.snapshot() })
	return out
}
func (s *Service) Open(in OpenInput) (State, error) {
	proxy, err := s.ensureCapture()
	if err != nil {
		return State{}, err
	}
	var out State
	mygo.RunOnMain(func() { s.host.proxy = proxy; out, err = s.host.open(in) })
	return out, err
}
func (s *Service) Select(id string) (State, error) {
	var out State
	var err error
	mygo.RunOnMain(func() {
		if s.host.find(id) == nil {
			err = errors.New("Browser tab no longer exists")
			return
		}
		s.host.selected = id
		s.host.changed()
		out = s.host.snapshot()
	})
	return out, err
}
func (s *Service) Close(id string) State {
	var out State
	mygo.RunOnMain(func() {
		h := s.host
		for i, p := range h.pages {
			if p.info.ID == id {
				h.pages = append(h.pages[:i], h.pages[i+1:]...)
				if h.viewport.TabID == id {
					h.viewport.Visible = false
				}
				p.view.Destroy()
				break
			}
		}
		if h.selected == id {
			h.selected = ""
			if len(h.pages) > 0 {
				h.selected = h.pages[len(h.pages)-1].info.ID
			}
		}
		h.changed()
		out = h.snapshot()
	})
	return out
}
func (s *Service) Navigate(id, raw string) error {
	if _, err := vault.Origin(raw); err != nil {
		return err
	}
	proxy, err := s.ensureCapture()
	if err != nil {
		return err
	}
	mygo.RunOnMain(func() {
		s.host.proxy = proxy
		if s.host.network != nil {
			if err = s.host.network.update(proxy.Addr, proxy.CACert); err != nil {
				return
			}
		}
		p := s.host.find(id)
		if p == nil {
			err = errors.New("Browser tab no longer exists")
			return
		}
		p.info.Loading = true
		p.info.Error = ""
		err = p.view.Page().LoadURL(raw)
		s.host.changed()
	})
	return err
}
func (s *Service) Action(id, action string) error {
	switch action {
	case "back", "forward", "reload", "stop":
	default:
		return errors.New("Unknown browser action")
	}
	var err error
	var proxy capture.Settings
	if action != "stop" {
		proxy, err = s.ensureCapture()
		if err != nil {
			return err
		}
	}
	mygo.RunOnMain(func() {
		if action != "stop" {
			s.host.proxy = proxy
			if s.host.network != nil {
				if err = s.host.network.update(proxy.Addr, proxy.CACert); err != nil {
					return
				}
			}
		}
		p := s.host.find(id)
		if p == nil {
			err = errors.New("Browser tab no longer exists")
			return
		}
		pg := p.view.Page()
		switch action {
		case "back":
			pg.GoBack()
		case "forward":
			pg.GoForward()
		case "reload":
			pg.Reload()
		case "stop":
			pg.Stop()
		default:
			err = errors.New("Unknown browser action")
		}
		s.host.refresh(p)
	})
	return err
}
func (s *Service) SetViewport(v Viewport) {
	mygo.RunOnMain(func() {
		for _, n := range []float32{v.X, v.Y, v.Width, v.Height, v.ClientWidth, v.ClientHeight} {
			if math.IsNaN(float64(n)) || math.IsInf(float64(n), 0) || n < 0 || n > 32768 {
				return
			}
		}
		if s.host.find(v.TabID) == nil {
			v.Visible = false
		}
		// DOM rectangles are CSS pixels; native placement uses window DIPs.
		// WebView zoom / desktop scaling can make these coordinate spaces differ.
		if v.Visible && s.host.win != nil {
			if v.ClientWidth <= 0 || v.ClientHeight <= 0 {
				return
			}
			width, height := s.host.win.ContentSize()
			sx, sy := float32(width)/v.ClientWidth, float32(height)/v.ClientHeight
			v.X *= sx
			v.Width *= sx
			v.Y *= sy
			v.Height *= sy
		}
		s.host.viewport = v
		if s.host.win != nil {
			s.host.win.Invalidate()
		}
	})
}
func (s *Service) Fill(ctx context.Context, in FillInput) error {
	var target *mygo.Page
	var raw string
	mygo.RunOnMain(func() {
		if p := s.host.find(in.TabID); p != nil && s.host.selected == in.TabID {
			target = p.view.Page()
			raw = target.URL()
		}
	})
	if target == nil {
		return errors.New("Select a browser tab before filling an account")
	}
	origin, err := vault.Origin(raw)
	if err != nil {
		return err
	}
	credential, err := s.vault.Credential(ctx, in.CredentialID, raw)
	if err != nil {
		return err
	}
	stillSelected := false
	mygo.RunOnMain(func() {
		p := s.host.find(in.TabID)
		stillSelected = p != nil && s.host.selected == in.TabID && p.view.Page().URL() == raw
	})
	if !stillSelected {
		return errors.New("Page changed before credentials could be filled")
	}
	data, _ := json.Marshal(map[string]string{"origin": origin, "username": credential.Username, "password": credential.Password})
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	result, err := target.EvalContext(ctx, strings.Replace(fillScript, "__ACRO_CREDENTIAL__", string(data), 1))
	if err != nil {
		return errors.New("Could not fill the selected page")
	}
	switch result {
	case "filled":
		return nil
	case "origin-changed":
		return errors.New("Page changed before credentials could be filled")
	case "cross-origin-form":
		return errors.New("The login form submits to a different origin")
	default:
		return errors.New("No supported password field found; open the password step of the login form")
	}
}

// VaultService only returns metadata; passwords pass directly to the local page executor.
type VaultService struct{ manager *vault.Manager }

func NewVaultService(v *vault.Manager) *VaultService { return &VaultService{v} }
func (s *VaultService) Status(ctx context.Context) (vault.Status, error) {
	return s.manager.Status(ctx)
}
func (s *VaultService) Unlock(ctx context.Context, in vault.LoginInput) (vault.Status, error) {
	return s.manager.Unlock(ctx, in)
}
func (s *VaultService) Lock()                            { s.manager.Lock() }
func (s *VaultService) Logout(ctx context.Context) error { return s.manager.Logout(ctx) }
func (s *VaultService) Accounts(ctx context.Context, rawURL string) ([]vault.Account, error) {
	return s.manager.List(ctx, rawURL)
}
func (s *VaultService) Save(ctx context.Context, in vault.SaveInput) (vault.Account, error) {
	return s.manager.Save(ctx, in)
}
func (s *VaultService) Delete(ctx context.Context, id, rawURL string) error {
	return s.manager.Delete(ctx, id, rawURL)
}
func (s *VaultService) Sync(ctx context.Context) error { return s.manager.Sync(ctx) }
