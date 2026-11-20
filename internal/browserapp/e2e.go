//go:build browser_e2e

package browserapp

import "github.com/egoist/mygo"

// These accessors exist only in the isolated native integration-test binary.
func (h *Host) TestShell() *mygo.Page {
	var p *mygo.Page
	mygo.RunOnMain(func() { p = h.shell.Page() })
	return p
}
func (h *Host) TestPage(id string) *mygo.Page {
	var p *mygo.Page
	mygo.RunOnMain(func() {
		if entry := h.find(id); entry != nil {
			p = entry.view.Page()
		}
	})
	return p
}
func (h *Host) TestViewport() Viewport {
	var v Viewport
	mygo.RunOnMain(func() { v = h.viewport })
	return v
}

func (h *Host) TestCapture(id string) ([]byte, error) {
	var view *mygo.WebView
	mygo.RunOnMain(func() { view = h.find(id).view })
	return view.CapturePage()
}

func (h *Host) TestContentBounds() mygo.Rectangle  { return h.win.ContentBounds() }
func (h *Host) TestWindowCapture() ([]byte, error) { return h.win.CapturePage() }
