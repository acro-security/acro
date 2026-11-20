//go:build browser_e2e

// Native smoke test: only synthetic local websites and disposable credentials.
package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"acro/internal/browserapp"
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
	service := browserapp.NewService(host, manager)
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
		go func() { defer mygo.App.Quit(); result <- verify(host, service, manager, site.URL) }()
	})
	if err = mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
	if err = <-result; err != nil {
		log.Fatal(err)
	}
	fmt.Println("Native browser: media, sustained OS input, scrolling, IPC isolation and credential fill passed")
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
