//go:build linux && !android

package browserapp

import (
	"encoding/pem"
	"errors"
	"fmt"

	"github.com/ebitengine/purego"
)

// WebKitGTK exposes proxy settings per WebsiteDataManager. MyGo v0.10 has
// no public proxy API, so this small platform adapter uses the public GTK tree
// rooted at Window.NativeHandle, never private MyGo fields or system settings.
type browserNetwork struct {
	children      func(uintptr) uintptr
	containerType func() uintptr
	webType       func() uintptr
	isA           func(uintptr, uintptr) bool
	freeList      func(uintptr)
	listLength    func(uintptr) uint32
	listAt        func(uintptr, uint32) uintptr
	getManager    func(uintptr) uintptr
	getContext    func(uintptr) uintptr
	getSettings   func(uintptr) uintptr
	setWebRTC     func(uintptr, bool)
	newProxy      func(string, uintptr) uintptr
	setProxy      func(uintptr, int32, uintptr)
	freeProxy     func(uintptr)
	newCert       func(string, int64, *uintptr) uintptr
	allowCert     func(uintptr, uintptr, string)
	ref           func(uintptr) uintptr
	unref         func(uintptr)
	freeError     func(uintptr)
	contexts      map[uintptr]networkContext
}
type networkContext struct {
	manager uintptr
	ca      string
	addr    string
}

func newBrowserNetwork() (*browserNetwork, error) {
	n := &browserNetwork{contexts: map[uintptr]networkContext{}}
	var libs []uintptr
	for _, name := range []string{"libgtk-3.so.0", "libwebkit2gtk-4.1.so.0", "libgio-2.0.so.0", "libgobject-2.0.so.0", "libglib-2.0.so.0"} {
		h, err := purego.Dlopen(name, purego.RTLD_NOW|purego.RTLD_LOCAL)
		if err != nil {
			return nil, fmt.Errorf("Browser capture cannot load %s", name)
		}
		libs = append(libs, h)
	}
	bindings := []struct {
		lib  int
		name string
		fn   any
	}{
		{0, "gtk_container_get_children", &n.children}, {0, "gtk_container_get_type", &n.containerType},
		{1, "webkit_web_view_get_type", &n.webType}, {3, "g_type_check_instance_is_a", &n.isA}, {4, "g_list_free", &n.freeList}, {4, "g_list_length", &n.listLength}, {4, "g_list_nth_data", &n.listAt},
		{1, "webkit_web_view_get_website_data_manager", &n.getManager}, {1, "webkit_web_view_get_context", &n.getContext},
		{1, "webkit_web_view_get_settings", &n.getSettings}, {1, "webkit_settings_set_enable_webrtc", &n.setWebRTC},
		{1, "webkit_network_proxy_settings_new", &n.newProxy}, {1, "webkit_website_data_manager_set_network_proxy_settings", &n.setProxy}, {1, "webkit_network_proxy_settings_free", &n.freeProxy},
		{2, "g_tls_certificate_new_from_pem", &n.newCert}, {1, "webkit_web_context_allow_tls_certificate_for_host", &n.allowCert},
		{3, "g_object_ref", &n.ref}, {3, "g_object_unref", &n.unref}, {4, "g_error_free", &n.freeError},
	}
	for _, b := range bindings {
		address, err := purego.Dlsym(libs[b.lib], b.name)
		if err != nil {
			return nil, fmt.Errorf("Browser capture requires %s", b.name)
		}
		purego.RegisterFunc(b.fn, address)
	}
	// Libraries stay loaded for the lifetime of their GTK objects and callbacks.
	return n, nil
}
func (n *browserNetwork) widgets(root uintptr) map[uintptr]bool {
	out := map[uintptr]bool{}
	var walk func(uintptr)
	walk = func(widget uintptr) {
		if widget == 0 {
			return
		}
		if n.isA(widget, n.webType()) {
			out[widget] = true
			return
		}
		if !n.isA(widget, n.containerType()) {
			return
		}
		list := n.children(widget)
		defer n.freeList(list)
		for i, count := uint32(0), n.listLength(list); i < count; i++ {
			walk(n.listAt(list, i))
		}
	}
	walk(root)
	return out
}
func (n *browserNetwork) configure(root uintptr, before map[uintptr]bool, addr, ca string) error {
	var view uintptr
	for widget := range n.widgets(root) {
		if !before[widget] {
			if view != 0 {
				return errors.New("Cannot identify the new browser WebView")
			}
			view = widget
		}
	}
	if view == 0 {
		return errors.New("Cannot locate the new browser WebView")
	}
	// WebRTC can create direct UDP connections outside an HTTP proxy.
	n.setWebRTC(n.getSettings(view), false)
	manager := n.getManager(view)
	context := n.getContext(view)
	if manager == 0 || context == 0 {
		return errors.New("Cannot configure the browser network session")
	}
	entry, ok := n.contexts[context]
	if !ok {
		n.ref(context)
	}
	entry.manager = manager
	n.contexts[context] = entry
	return n.update(addr, ca)
}
func (n *browserNetwork) update(addr, ca string) error {
	settings := n.newProxy("http://"+addr, 0)
	if settings == 0 {
		return errors.New("Cannot create browser proxy settings")
	}
	defer n.freeProxy(settings)
	for context, entry := range n.contexts {
		// Reapplying unchanged settings can tear down other tabs' connections.
		if entry.addr == addr && entry.ca == ca {
			continue
		}
		n.setProxy(entry.manager, 2, settings)
		entry.addr = addr
		entry.ca = ca
		n.contexts[context] = entry
	}
	return nil
}
func (n *browserNetwork) trust(host string, der []byte) {
	for context, entry := range n.contexts {
		data := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})) + entry.ca
		var errorPtr uintptr
		cert := n.newCert(data, int64(len(data)), &errorPtr)
		if errorPtr != 0 {
			n.freeError(errorPtr)
		}
		if cert != 0 {
			n.allowCert(context, cert, host)
			n.unref(cert)
		}
	}
}
func (n *browserNetwork) close() {
	for context := range n.contexts {
		n.unref(context)
	}
	n.contexts = map[uintptr]networkContext{}
}
