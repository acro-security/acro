package main

import (
	"log"

	"acro/internal/captureapp"
	"acro/internal/replay"
	"github.com/egoist/mygo"
)

// main owns the window and the IPC surface. Everything users see lives in the
// TypeScript frontend; this side executes HTTP and nothing else, so the same
// binding can serve a future agent harness.
func main() {
	// Each service takes an explicit name: both types are "Service", and the
	// generated client names them separately.
	mygo.BindAs("Replay", replay.NewService())
	capturing := captureapp.NewService()
	defer capturing.Close()
	mygo.BindAs("Capture", capturing)
	mygo.App.WhenReady(func() {
		mygo.NewWindow(mygo.WindowOptions{
			Title:  "Acro",
			URL:    "/",
			Width:  1440,
			Height: 940,
			// The rail and the request/response split need room; below this the
			// layout stacks instead.
			MinWidth:        820,
			MinHeight:       560,
			StateKey:        "main",
			BackgroundColor: "light-dark(#fbfbfc, #0b0c0d)",
		})
	})
	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}
