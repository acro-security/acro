//go:build browser_e2e

// Native smoke test: only synthetic local websites and disposable credentials.
package main

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha1"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"acro/internal/browserapp"
	"acro/internal/capture"
	"acro/internal/vault"
	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

func main() {
	dir, err := os.MkdirTemp("", "acro-browser-smoke-")
	if err != nil {
		log.Fatal(err)
	}
	defer os.RemoveAll(dir)
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/tone.wav" {
			w.Header().Set("Content-Type", "audio/wav")
			_ = binary.Write(w, binary.LittleEndian, []byte("RIFF"))
			_ = binary.Write(w, binary.LittleEndian, uint32(36+1600))
			_, _ = w.Write([]byte("WAVEfmt "))
			_ = binary.Write(w, binary.LittleEndian, uint32(16))
			_ = binary.Write(w, binary.LittleEndian, []uint16{1, 1})
			_ = binary.Write(w, binary.LittleEndian, []uint32{8000, 16000})
			_ = binary.Write(w, binary.LittleEndian, []uint16{2, 16})
			_, _ = w.Write([]byte("data"))
			_ = binary.Write(w, binary.LittleEndian, uint32(1600))
			_, _ = w.Write(bytes.Repeat([]byte{0}, 1600))
			return
		}
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, `<!doctype html><title>Local login fixture</title><form><label>Username<input name="username" autocomplete="username"></label><label>Password<input name="password" type="password"></label><button>Login</button></form><audio id="test-audio" controls preload="auto" src="/tone.wav"></audio><div style="height:4000px"><p id="heartbeat"></p></div><script>setInterval(()=>{document.querySelector("#heartbeat").textContent=String(Date.now());window.testAllocation=Array.from({length:5000},()=>({value:Math.random()}))},100)</script>`)
	}))
	defer site.Close()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		log.Fatal(err)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(1), NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), DNSNames: []string{"localhost"}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, KeyUsage: x509.KeyUsageDigitalSignature}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		log.Fatal(err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		log.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(cert)
	secure := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		switch r.URL.Path {
		case "/socket":
			conn, buffer, err := w.(http.Hijacker).Hijack()
			if err != nil {
				return
			}
			defer conn.Close()
			digest := sha1.Sum([]byte(r.Header.Get("Sec-WebSocket-Key") + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
			_, _ = fmt.Fprintf(buffer, "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: %s\r\n\r\n", base64.StdEncoding.EncodeToString(digest[:]))
			_, _ = buffer.Write([]byte{0x81, 2, 'o', 'k'})
			_ = buffer.Flush()
			_, _ = io.Copy(io.Discard, buffer)
		case "/asset.js":
			w.Header().Set("Content-Type", "application/javascript")
			fmt.Fprint(w, `document.documentElement.dataset.asset="loaded"`)
		case "/post", "/blocked":
			fmt.Fprint(w, "ok")
		default:
			w.Header().Set("Content-Type", "text/html")
			_, port, _ := net.SplitHostPort(r.Host)
			fmt.Fprintf(w, `<!doctype html><title>Secure fixture</title><script src="https://localhost:%s/asset.js"></script>`, port)
		}
	}))
	secure.TLS = &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}}
	secure.StartTLS()
	defer secure.Close()
	data, _ := json.Marshal(map[string]any{"id": "11111111-2222-4333-8444-555555555555", "type": 1, "name": "Fixture account", "login": map[string]any{"username": "fixture-user", "password": "fixture-secret", "uris": []map[string]string{{"uri": site.URL}}}})
	token := base64.StdEncoding.EncodeToString([]byte("01234567890123456789012345678901"))
	script := "#!/bin/sh\ncase \"$1\" in\nstatus) if [ -n \"$BW_SESSION\" ]; then echo '{\"status\":\"unlocked\",\"serverUrl\":\"http://localhost\"}'; else echo '{\"status\":\"locked\",\"serverUrl\":\"http://localhost\"}'; fi;;\nunlock) echo " + token + ";;\nlist) cat <<'FIXTURE'\n[" + string(data) + "]\nFIXTURE\n;;\nget) cat <<'FIXTURE'\n" + string(data) + "\nFIXTURE\n;;\n*) exit 1;;\nesac\n"
	if err = os.WriteFile(filepath.Join(dir, "bw"), []byte(script), 0700); err != nil {
		log.Fatal(err)
	}
	os.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	mygo.App.SetName("Acro Browser Smoke")
	mygo.SetFrontend(os.DirFS("dist"))
	manager := vault.New(filepath.Join(dir, "profile"))
	defer manager.Lock()
	host := browserapp.NewHost()
	var captureMu sync.Mutex
	var captured []capture.Traffic
	upstreamTLS := &tls.Config{RootCAs: roots}
	if os.Getenv("ACRO_BROWSER_TEST_URL") != "" {
		upstreamTLS = nil
	}
	proxy, err := capture.New(capture.Options{Port: 0, CADir: filepath.Join(dir, "ca"), OnCertificate: host.TrustProxyCertificate, UpstreamTLS: upstreamTLS, OnTraffic: func(tr capture.Traffic) { captureMu.Lock(); defer captureMu.Unlock(); captured = append(captured, tr) }})
	if err != nil {
		log.Fatal(err)
	}
	defer proxy.Stop()
	service := browserapp.NewService(host, manager, proxy)
	mygo.BindAs("Browser", service)
	mygo.BindAs("Vault", browserapp.NewVaultService(manager))
	// The normal shell also requests these at mount.
	mygo.BindAs("Capture", &captureStub{})
	result := make(chan error, 1)
	mygo.App.WhenReady(func() {
		w := mygo.NewWindow(mygo.WindowOptions{Title: "Acro smoke", Width: 1280, Height: 900, Content: ui.View(host.View)})
		if err := host.Attach(w); err != nil {
			result <- err
			mygo.App.Quit()
			return
		}
		go func() {
			defer mygo.App.Quit()
			if target := os.Getenv("ACRO_BROWSER_TEST_URL"); target != "" {
				err := verifyExternal(host, service, target)
				captureMu.Lock()
				for _, tr := range captured {
					log.Printf("Capture: %s %s status=%d error=%s", tr.Method, tr.Host, tr.Status, tr.Error)
				}
				captureMu.Unlock()
				result <- err
				return
			}
			if err := verify(host, service, manager, site.URL); err != nil {
				result <- err
				return
			}
			err := verifyNetwork(host, service, proxy, site.URL, secure.URL)
			captureMu.Lock()
			defer captureMu.Unlock()
			if err == nil {
				for _, path := range []string{"/tone.wav", "/asset.js", "/post", "/resumed", "/socket"} {
					found := false
					for _, tr := range captured {
						if strings.HasSuffix(tr.URL, path) && (tr.Status == 200 || path == "/socket" && tr.Status == 101) {
							found = true
						}
					}
					if !found {
						err = fmt.Errorf("Browser request was not captured: %s; records=%+v", path, captured)
						break
					}
				}
				for _, tr := range captured {
					if strings.HasSuffix(tr.URL, "/blocked") {
						err = errors.New("Browser bypassed the stopped capture proxy")
					}
				}
			}
			result <- err
		}()
	})
	if err = mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
	if err = <-result; err != nil {
		log.Fatal(err)
	}
	if os.Getenv("ACRO_BROWSER_TEST_URL") != "" {
		fmt.Println("External browser page and capture verification passed")
	} else {
		fmt.Println("Native browser: media, sustained OS input, scrolling, credential fill, HTTP/HTTPS capture, cross-host assets, POST, project isolation and proxy stop/restart passed")
	}
}

func verifyExternal(h *browserapp.Host, s *browserapp.Service, target string) error {
	state, err := s.Open(browserapp.OpenInput{URL: target})
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pg := h.TestPage(state.SelectedID)
	var loadErr error
	err = wait(func() bool {
		state = s.Status()
		if len(state.Tabs) > 0 && state.Tabs[0].Error != "" {
			loadErr = errors.New(state.Tabs[0].Error)
			return true
		}
		value, e := pg.EvalContext(ctx, `return {url:location.href,title:document.title,ready:document.readyState,text:document.body?.innerText?.slice(0,100)}`)
		if e == nil {
			data, ok := value.(map[string]any)
			if ok && data["url"] == target && data["title"] != "" && data["ready"] == "complete" {
				log.Printf("External page loaded: %+v", data)
				return true
			}
		}
		return false
	})
	if loadErr != nil {
		return loadErr
	}
	return err
}

func verifyNetwork(h *browserapp.Host, s *browserapp.Service, proxy *capture.Proxy, plain, secure string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	state := s.Status()
	original := h.TestPage(state.SelectedID)
	if _, err := original.EvalContext(ctx, `document.cookie="project=first;path=/";return true`); err != nil {
		return err
	}
	state, err := s.Open(browserapp.OpenInput{URL: plain, ProjectID: "other-project"})
	if err != nil {
		return err
	}
	pg := h.TestPage(state.SelectedID)
	if err = wait(func() bool {
		v, e := pg.EvalContext(ctx, `return !!document.querySelector('form')`)
		return e == nil && v == true
	}); err != nil {
		return err
	}
	isolated, err := pg.EvalContext(ctx, `return !document.cookie.includes("project=first")`)
	if err != nil || isolated != true {
		return errors.New("Browser project cookies are not isolated")
	}
	if err = s.Navigate(state.SelectedID, secure); err != nil {
		return err
	}
	if err = wait(func() bool {
		v, e := pg.EvalContext(ctx, `return document.documentElement.dataset.asset === "loaded"`)
		return e == nil && v == true
	}); err != nil {
		return errors.New("HTTPS page or third-party HTTPS script failed through capture")
	}
	posted, err := pg.EvalContext(ctx, `return await (await fetch('/post',{method:'POST',body:'fixture-body'})).text() === 'ok'`)
	if err != nil || posted != true {
		return fmt.Errorf("HTTPS POST through capture failed: %v", err)
	}
	socket, err := pg.EvalContext(ctx, `return await new Promise(resolve=>{const ws=new WebSocket('wss://'+location.host+'/socket');window.testSocket=ws;const timer=setTimeout(()=>{ws.close();resolve(false)},5000);ws.onmessage=e=>{clearTimeout(timer);resolve(e.data==='ok')};ws.onerror=()=>{clearTimeout(timer);resolve(false)}})`)
	if err != nil || socket != true {
		return fmt.Errorf("Secure WebSocket through capture failed: %v", err)
	}
	second, err := s.Open(browserapp.OpenInput{URL: secure, ProjectID: "other-project"})
	if err != nil {
		return err
	}
	secondPage := h.TestPage(second.SelectedID)
	if err = wait(func() bool {
		v, e := secondPage.EvalContext(ctx, `return document.documentElement.dataset.asset === "loaded"`)
		return e == nil && v == true
	}); err != nil {
		return err
	}
	connected, err := pg.EvalContext(ctx, `return window.testSocket.readyState === WebSocket.OPEN`)
	if err != nil || connected != true {
		return errors.New("Opening a tab interrupted another tab's WebSocket")
	}
	if _, err = s.Select(state.SelectedID); err != nil {
		return err
	}
	if err = proxy.Stop(); err != nil {
		return err
	}
	blocked, err := pg.EvalContext(ctx, `try { await fetch('/blocked',{cache:'no-store'}); return false } catch { return true }`)
	if err != nil || blocked != true {
		return errors.New("Browser bypassed capture after proxy stop")
	}
	// Do not mistake the previous document for a completed reload.
	if _, err = pg.EvalContext(ctx, `delete document.documentElement.dataset.asset; return true`); err != nil {
		return err
	}
	if err = s.Action(state.SelectedID, "reload"); err != nil {
		return err
	}
	if err = wait(func() bool {
		v, e := pg.EvalContext(ctx, `return document.documentElement.dataset.asset === "loaded"`)
		return e == nil && v == true
	}); err != nil {
		return err
	}
	resumed, err := pg.EvalContext(ctx, `return await (await fetch('/resumed',{cache:'no-store'})).ok`)
	if err != nil || resumed != true {
		return fmt.Errorf("Browser capture did not recover after restart: %v", err)
	}
	return nil
}

type captureStub struct{}

func (*captureStub) Status() map[string]any {
	return map[string]any{"running": false, "addr": "", "port": 8081, "captured": 0}
}
func (*captureStub) History() []string { return []string{} }
func wait(fn func() bool) error {
	deadline := time.Now().Add(25 * time.Second)
	for time.Now().Before(deadline) {
		if fn() {
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return errors.New("Native browser test timed out")
}
func verify(h *browserapp.Host, s *browserapp.Service, m *vault.Manager, rawURL string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Second)
	defer cancel()
	shell := h.TestShell()
	shell.SetZoomFactor(1.25)
	if err := wait(func() bool {
		v, e := shell.EvalContext(ctx, `return !!document.querySelector('button[aria-label="Browser"]')`)
		return e == nil && v == true
	}); err != nil {
		return err
	}
	if _, err := shell.EvalContext(ctx, `document.querySelector('button[aria-label="Browser"]').click(); return true`); err != nil {
		return err
	}
	state, err := s.Open(browserapp.OpenInput{URL: rawURL, ProjectID: ""})
	if err != nil {
		return err
	}
	pg := h.TestPage(state.SelectedID)
	if err = wait(func() bool {
		v, e := pg.EvalContext(ctx, `return !!document.querySelector('input[type="password"]')`)
		return e == nil && v == true
	}); err != nil {
		return err
	}
	if err = wait(func() bool { v := h.TestViewport(); return v.Visible && v.Width > 200 && v.Height > 100 }); err != nil {
		return err
	}
	// OS mouse and keyboard events must reach both guest and shell WebViews.
	if err := verifyInput(ctx, h, pg); err != nil {
		return err
	}
	isolation, err := pg.EvalContext(ctx, `if (!window.mygo) return true; try { await window.mygo.call("Vault.Status"); return false; } catch { return true; }`)
	if err != nil || isolation != true {
		return errors.New("Guest page can access privileged IPC")
	}
	if _, err = m.Unlock(ctx, vault.LoginInput{Password: "fixture-master"}); err != nil {
		return err
	}
	if err = s.Fill(ctx, browserapp.FillInput{TabID: state.SelectedID, CredentialID: "11111111-2222-4333-8444-555555555555"}); err != nil {
		return err
	}
	filled, err := pg.EvalContext(ctx, `return document.querySelector('[name="username"]').value === "fixture-user" && document.querySelector('[name="password"]').value === "fixture-secret"`)
	if err != nil || filled != true {
		return errors.New("Native credential fill failed")
	}
	png, err := h.TestCapture(state.SelectedID)
	if err != nil {
		return err
	}
	if err = os.WriteFile("/tmp/acro-browser-native.png", png, 0600); err != nil {
		return err
	}
	// Exercise the browser after two background vault status polls and sustained repainting.
	time.Sleep(35 * time.Second)
	if err := verifyInput(ctx, h, pg); err != nil {
		return fmt.Errorf("browser input after idle: %w", err)
	}
	bounds := h.TestContentBounds()
	v := h.TestViewport()
	if err := exec.CommandContext(ctx, "xdotool", "mousemove", "--sync", strconv.Itoa(bounds.X+int(v.X)+200), strconv.Itoa(bounds.Y+int(v.Y)+150), "click", "--repeat", "6", "--delay", "80", "5").Run(); err != nil {
		return err
	}
	if err := wait(func() bool {
		value, e := pg.EvalContext(ctx, `return window.scrollY > 0`)
		return e == nil && value == true
	}); err != nil {
		return errors.New("OS wheel events did not scroll the guest WebView")
	}
	return nil
}

func verifyInput(ctx context.Context, h *browserapp.Host, pg *mygo.Page) error {
	if _, err := exec.LookPath("xdotool"); err != nil {
		return errors.New("Native input test requires xdotool")
	}
	output, err := exec.CommandContext(ctx, "xdotool", "search", "--name", "^Acro smoke$").Output()
	if err != nil {
		return err
	}
	ids := strings.Fields(string(output))
	if len(ids) == 0 {
		return errors.New("Native test window not found")
	}
	if err := exec.CommandContext(ctx, "xdotool", "windowfocus", "--sync", ids[0]).Run(); err != nil {
		return err
	}
	bounds := h.TestContentBounds()
	shell := h.TestShell()
	shellRect, err := shell.EvalContext(ctx, `const r=document.querySelector('input[aria-label="Website address"]').getBoundingClientRect();return {x:r.x+8,y:r.y+r.height/2,w:innerWidth,h:innerHeight}`)
	if err != nil {
		return err
	}
	shellPos := shellRect.(map[string]any)
	sx, sy := bounds.X+int(shellPos["x"].(float64)*float64(bounds.Width)/shellPos["w"].(float64)), bounds.Y+int(shellPos["y"].(float64)*float64(bounds.Height)/shellPos["h"].(float64))
	if err = exec.CommandContext(ctx, "xdotool", "mousemove", "--sync", strconv.Itoa(sx), strconv.Itoa(sy), "click", "1", "key", "ctrl+a", "type", "--clearmodifiers", "--delay", "10", "https://input-check.example").Run(); err != nil {
		return err
	}
	if err = wait(func() bool {
		value, e := shell.EvalContext(ctx, `return document.querySelector('input[aria-label="Website address"]').value === "https://input-check.example"`)
		return e == nil && value == true
	}); err != nil {
		if png, e := h.TestWindowCapture(); e == nil {
			_ = os.WriteFile("/tmp/acro-shell-input-failure.png", png, 0600)
		}
		diagnostic, _ := shell.EvalContext(ctx, `const a=document.activeElement;return {tag:a?.tagName,label:a?.getAttribute("aria-label"),value:document.querySelector('input[aria-label="Website address"]').value,rect:document.querySelector('input[aria-label="Website address"]').getBoundingClientRect().toJSON()}`)
		return fmt.Errorf("OS input did not reach the workbench address bar at %d,%d; content=%+v viewport=%+v DOM=%+v", sx, sy, bounds, h.TestViewport(), diagnostic)
	}
	viewport := h.TestViewport()
	raw, err := pg.EvalContext(ctx, `const r=document.querySelector('[name="username"]').getBoundingClientRect(); return {x:r.x+8,y:r.y+r.height/2,w:innerWidth,h:innerHeight}`)
	if err != nil {
		return err
	}
	pos := raw.(map[string]any)
	x := bounds.X + int(viewport.X) + int(pos["x"].(float64)*float64(viewport.Width)/pos["w"].(float64))
	y := bounds.Y + int(viewport.Y) + int(pos["y"].(float64)*float64(viewport.Height)/pos["h"].(float64))
	if err = exec.CommandContext(ctx, "xdotool", "mousemove", "--sync", strconv.Itoa(x), strconv.Itoa(y), "click", "1", "key", "ctrl+a", "type", "--clearmodifiers", "--delay", "10", "typed-user").Run(); err != nil {
		return err
	}
	if err = wait(func() bool {
		value, e := pg.EvalContext(ctx, `return document.querySelector('[name="username"]').value === "typed-user"`)
		return e == nil && value == true
	}); err != nil {
		if png, e := h.TestWindowCapture(); e == nil {
			_ = os.WriteFile("/tmp/acro-input-failure.png", png, 0600)
		}
		return fmt.Errorf("OS input did not reach the guest WebView at %d,%d: %w", x, y, err)
	}
	return nil
}
