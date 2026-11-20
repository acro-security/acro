//go:build !linux || android

package browserapp

import "errors"

type browserNetwork struct{}

func newBrowserNetwork() (*browserNetwork, error) {
	return nil, errors.New("Automatic browser capture currently requires Linux WebKitGTK")
}
func (*browserNetwork) widgets(uintptr) map[uintptr]bool { return nil }
func (*browserNetwork) configure(uintptr, map[uintptr]bool, string, string) error {
	return errors.New("Browser capture is unavailable on this platform")
}
func (*browserNetwork) trust(string, []byte) {}
func (*browserNetwork) close()               {}

func (*browserNetwork) update(string, string) error {
	return errors.New("Browser capture is unavailable on this platform")
}
