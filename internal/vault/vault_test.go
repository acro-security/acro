package vault

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

const testID = "11111111-2222-4333-8444-555555555555"

func sample() item {
	return item{ID: testID, Type: 1, Name: "Local account", Login: &login{Username: "alice", Password: "fixture-secret", URIs: []uri{{URI: "https://example.test/login"}}}}
}
func fixture(t *testing.T) *Manager {
	t.Helper()
	m := New(t.TempDir())
	m.available = func() bool { return true }
	m.session = "session"
	m.run = func(_ context.Context, args []string, session, password, dir string) ([]byte, error) {
		switch args[0] {
		case "status":
			state := "locked"
			if session != "" {
				state = "unlocked"
			}
			return json.Marshal(map[string]string{"status": state, "serverUrl": "https://vault.test", "userEmail": "alice@test"})
		case "list":
			return json.Marshal([]item{sample()})
		case "get":
			return json.Marshal(sample())
		default:
			return nil, errors.New("Unexpected fixture operation")
		}
	}
	t.Cleanup(m.Lock)
	return m
}
func TestMetadataAndExactOriginPolicy(t *testing.T) {
	m := fixture(t)
	ctx := context.Background()
	accounts, err := m.List(ctx, "https://example.test:443/account")
	if err != nil || len(accounts) != 1 {
		t.Fatalf("metadata: %v %v", accounts, err)
	}
	out, _ := json.Marshal(accounts)
	if strings.Contains(string(out), "fixture-secret") || strings.Contains(string(out), "password") {
		t.Fatal("metadata leaked password")
	}
	for _, raw := range []string{"https://evil.test", "http://example.test", "https://example.test.evil.test", "https://example.test:8443"} {
		if _, err = m.Credential(ctx, testID, raw); err == nil {
			t.Fatalf("allowed %s", raw)
		}
	}
	credential, err := m.Credential(ctx, testID, "https://example.test")
	if err != nil || credential.Password != "fixture-secret" {
		t.Fatal("could not retrieve authorized fixture")
	}
	m.Lock()
	if _, err = m.List(ctx, "https://example.test"); err == nil {
		t.Fatal("locked vault returned accounts")
	}
}
func TestOrigins(t *testing.T) {
	for raw, want := range map[string]string{"https://EXAMPLE.test:443/a": "https://example.test", "http://localhost:80/a": "http://localhost", "http://[::1]:8080/": "http://[::1]:8080"} {
		got, err := Origin(raw)
		if err != nil || got != want {
			t.Fatalf("%s: %s %v", raw, got, err)
		}
	}
	for _, raw := range []string{"javascript:alert(1)", "file:///tmp/passwords", "https://user:pass@example.test", "data:text/html,test", "about:blank"} {
		if _, err := Origin(raw); err == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
}
func TestUnlockNeverPassesMasterPasswordAsArgument(t *testing.T) {
	m := fixture(t)
	m.session = ""
	var gotPassword string
	m.run = func(_ context.Context, args []string, session, password, dir string) ([]byte, error) {
		for _, arg := range args {
			if strings.Contains(arg, "master-fixture") {
				t.Fatal("master password in arguments")
			}
		}
		if args[0] == "unlock" {
			gotPassword = password
			return []byte(base64.StdEncoding.EncodeToString([]byte("01234567890123456789012345678901"))), nil
		}
		if args[0] == "status" {
			return []byte(`{"status":"locked"}`), nil
		}
		return nil, errors.New("unexpected operation")
	}
	if _, err := m.Unlock(context.Background(), LoginInput{Password: "master-fixture"}); err != nil {
		t.Fatal(err)
	}
	if gotPassword != "master-fixture" || m.session == "" {
		t.Fatal("unlock session was not retained")
	}
}
func TestRejectsInvalidIDsBeforeCallingCLI(t *testing.T) {
	m := fixture(t)
	m.run = func(context.Context, []string, string, string, string) ([]byte, error) {
		t.Fatal("CLI called for invalid id")
		return nil, nil
	}
	for _, id := range []string{"--help", "name", "../vault", strings.Repeat("a", 36)} {
		if _, err := m.Credential(context.Background(), id, "https://example.test"); err == nil {
			t.Fatal("invalid id accepted")
		}
	}
}
func fakeCLI(t *testing.T, body string) {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "bw"), []byte("#!/bin/sh\n"+body), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}
func TestCLIChildEnvironmentAndErrorRedaction(t *testing.T) {
	fakeCLI(t, `printf '%s\n' "$BW_SESSION" "$ACRO_BW_PASSWORD" "$BITWARDENCLI_APPDATA_DIR"`)
	t.Setenv("BW_SESSION", "inherited-secret")
	out, err := runCLI(context.Background(), []string{"status"}, "child-session", "child-password", "/tmp/isolated-profile")
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != "child-session\nchild-password\n/tmp/isolated-profile\n" {
		t.Fatal("child credentials not isolated")
	}
	fakeCLI(t, `echo 'fixture-secret' >&2; exit 1`)
	_, err = runCLI(context.Background(), nil, "", "", "/tmp/fixture")
	if err == nil || strings.Contains(err.Error(), "fixture-secret") {
		t.Fatal("CLI error was not redacted")
	}
}
func TestSaveSendsSecretsOnStdinAndPreservesOtherFields(t *testing.T) {
	m := fixture(t)
	capture := filepath.Join(t.TempDir(), "encoded")
	t.Setenv("ACRO_TEST_CAPTURE", capture)
	fakeCLI(t, `case "$*" in *'fixture-secret'*) exit 3;; esac
cat > "$ACRO_TEST_CAPTURE"
printf '%s' '{"id":"11111111-2222-4333-8444-555555555555","type":1,"name":"Saved","login":{"username":"alice","password":"fixture-secret","uris":[{"uri":"https://example.test"}]}}'`)
	m.run = func(_ context.Context, args []string, _, _, _ string) ([]byte, error) {
		if reflect.DeepEqual(args, []string{"get", "item", testID, "--nointeraction"}) {
			return []byte(`{"id":"11111111-2222-4333-8444-555555555555","type":1,"notes":"keep","login":{"username":"old","password":"original","totp":"keep-totp","uris":[{"uri":"https://example.test"}]}}`), nil
		}
		return nil, errors.New("unexpected")
	}
	_, err := m.Save(context.Background(), SaveInput{ID: testID, Name: "Edited", URL: "https://example.test", Username: "alice"})
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := os.ReadFile(capture)
	data, err := base64.StdEncoding.DecodeString(string(encoded))
	if err != nil {
		t.Fatal(err)
	}
	var v map[string]any
	_ = json.Unmarshal(data, &v)
	l := v["login"].(map[string]any)
	if v["notes"] != "keep" || l["totp"] != "keep-totp" || l["password"] != "original" {
		t.Fatal("edit lost unexposed fields or existing password")
	}
}

func TestRestrictedURIMatching(t *testing.T) {
	for _, tc := range []struct {
		mode   int
		target string
		want   bool
	}{
		{5, "https://example.test/login", false}, {4, "https://example.test/login", false},
		{3, "https://example.test/login", true}, {3, "https://example.test/other", false},
		{2, "https://example.test/login/next", true}, {2, "https://example.test/other", false},
	} {
		v := sample()
		v.Login.URIs[0].Match = &tc.mode
		if got := allowed(v, tc.target); got != tc.want {
			t.Fatalf("mode %d on %s = %v", tc.mode, tc.target, got)
		}
	}
}
