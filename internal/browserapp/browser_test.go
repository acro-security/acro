package browserapp

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestBrowserSnapshotsContainNoSecretOrNativeHandle(t *testing.T) {
	h := NewHost()
	h.pages = []*page{{info: Tab{ID: "tab", Title: "Title", URL: "https://example.test", ProjectID: "project"}}}
	data, err := json.Marshal(h.snapshot())
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"password", "view", "session", "credential"} {
		if strings.Contains(string(data), key) {
			t.Fatalf("unexpected field %s", key)
		}
	}
	if !strings.Contains(string(data), "https://example.test") {
		t.Fatal("tab metadata missing")
	}
}
