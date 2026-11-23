package main

import (
	"acro/internal/browserapp"
	"acro/internal/vault"
	"github.com/egoist/mygo/ui"
	"log"
	"os"
	"path/filepath"

	"acro/internal/captureapp"
	"acro/internal/replay"
	"github.com/egoist/mygo"
)

// main hosts the React workbench and isolated guest WebViews in a native window.
// Go owns HTTP execution, browser sessions and the local credential executor.
func main() {
	// The embedded browser draws pages with WebKitGTK's DMA-BUF renderer where
	// it works: drawn on the CPU instead, long pages scroll at a fraction of
	// the frame rate, which is what makes the guest WebView feel damped.
	// "auto" leaves it on for hosts known to draw with it (Wayland with a
	// Mesa GPU, outside containers and virtual machines) and off elsewhere.
	mygo.App.SetDMABUFRenderer(mygo.DMABUFRendererAuto)
	// Each service takes an explicit name: both types are "Service", and the
	// generated client names them separately.
	mygo.BindAs("Replay", replay.NewService())
	config, err := os.UserConfigDir()
	if err != nil {
		log.Fatal(err)
	}
	credentials := vault.New(filepath.Join(config, "acro", "bitwarden"))
	defer credentials.Lock()
	host := browserapp.NewHost()
	capturing := captureapp.NewService(host.TrustProxyCertificate)
	mygo.BindAs("Browser", browserapp.NewService(host, credentials, capturing))
	mygo.BindAs("Vault", browserapp.NewVaultService(credentials))
	defer capturing.Close()
	mygo.BindAs("Capture", capturing)
	mygo.App.WhenReady(func() {
		win := mygo.NewWindow(mygo.WindowOptions{
			Title:   "Acro",
			Content: ui.View(host.View),
			Width:   1440,
			Height:  940,
			// The rail and the request/response split need room; below this the
			// layout stacks instead.
			TitleBarStyle:     mygo.TitleBarHidden,
			TitleBarHeight:    36,
			HideWindowButtons: true,
			MinWidth:          820,
			MinHeight:         560,
			StateKey:          "main",
			BackgroundColor:   "light-dark(#fbfbfc, #0e0c10)",
		})
		if err := host.Attach(win); err != nil {
			log.Fatal(err)
		}
	})
	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}
