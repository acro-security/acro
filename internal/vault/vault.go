// Package vault integrates the official Password Manager CLI. Secrets never
// appear in its public metadata types or CLI errors.
package vault

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type Status struct {
	Available bool   `json:"available"`
	State     string `json:"state"`
	Server    string `json:"server"`
	Email     string `json:"email"`
}
type Account struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	Username string   `json:"username"`
	Origins  []string `json:"origins"`
}
type LoginInput struct {
	Email    string `json:"email"`
	Password string `json:"password"`
	Code     string `json:"code"`
	Server   string `json:"server"`
}
type SaveInput struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	URL      string `json:"url"`
	Username string `json:"username"`
	Password string `json:"password"`
}
type Credential struct{ Username, Password string }
type item struct {
	ID          string  `json:"id"`
	Type        int     `json:"type"`
	Name        string  `json:"name"`
	Login       *login  `json:"login"`
	DeletedDate *string `json:"deletedDate"`
}
type login struct {
	Username string `json:"username"`
	Password string `json:"password"`
	URIs     []uri  `json:"uris"`
}
type uri struct {
	URI   string `json:"uri"`
	Match *int   `json:"match"`
}
type runner func(context.Context, []string, string, string, string) ([]byte, error)
type Manager struct {
	mu        sync.Mutex
	dir       string
	session   string
	timer     *time.Timer
	epoch     uint64
	run       runner
	available func() bool
}

func New(dir string) *Manager {
	return &Manager{dir: dir, run: runCLI, available: func() bool { _, err := exec.LookPath("bw"); return err == nil }}
}
func runCLI(ctx context.Context, args []string, session, password, dir string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "bw", args...)
	for _, env := range os.Environ() {
		key, _, _ := strings.Cut(env, "=")
		if key != "BW_SESSION" && key != "BW_PASSWORD" && key != "ACRO_BW_PASSWORD" && key != "BITWARDENCLI_APPDATA_DIR" && key != "BITWARDENCLI_DEBUG" {
			cmd.Env = append(cmd.Env, env)
		}
	}
	cmd.Env = append(cmd.Env, "BITWARDENCLI_APPDATA_DIR="+dir, "BW_SESSION="+session, "ACRO_BW_PASSWORD="+password)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		if ctx.Err() != nil {
			return nil, errors.New("Bitwarden operation timed out or was cancelled")
		}
		return nil, errors.New("Bitwarden operation failed; check the connection, credentials and vault state")
	}
	return out, nil
}
func (m *Manager) call(ctx context.Context, password string, args ...string) ([]byte, error) {
	if !m.available() {
		return nil, errors.New("Bitwarden CLI not found; install bw and restart Acro")
	}
	if err := os.MkdirAll(m.dir, 0700); err != nil {
		return nil, errors.New("Cannot create the Bitwarden profile directory")
	}
	_ = os.Chmod(m.dir, 0700)
	return m.run(ctx, args, m.session, password, m.dir)
}
func (m *Manager) status(ctx context.Context) (Status, error) {
	s := Status{Available: m.available(), State: "unauthenticated", Server: "https://vault.bitwarden.com"}
	if !s.Available {
		return s, nil
	}
	data, err := m.call(ctx, "", "status")
	if err != nil {
		return s, err
	}
	var raw struct {
		Status    string `json:"status"`
		ServerURL string `json:"serverUrl"`
		Email     string `json:"userEmail"`
	}
	if json.Unmarshal(data, &raw) != nil {
		return s, errors.New("Bitwarden returned an invalid status")
	}
	s.State = raw.Status
	s.Email = raw.Email
	if raw.ServerURL != "" {
		s.Server = raw.ServerURL
	}
	return s, nil
}
func (m *Manager) Status(ctx context.Context) (Status, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.status(ctx)
}
func (m *Manager) touch() {
	m.epoch++
	epoch := m.epoch
	if m.timer != nil {
		m.timer.Stop()
	}
	m.timer = time.AfterFunc(10*time.Minute, func() {
		m.mu.Lock()
		defer m.mu.Unlock()
		if m.epoch == epoch {
			m.session = ""
		}
	})
}
func (m *Manager) Unlock(ctx context.Context, in LoginInput) (Status, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if in.Password == "" {
		return Status{}, errors.New("Master password is required")
	}
	s, err := m.status(ctx)
	if err != nil {
		return s, err
	}
	args := []string{"unlock", "--raw", "--passwordenv", "ACRO_BW_PASSWORD", "--nointeraction"}
	if s.State == "unauthenticated" {
		server := strings.TrimSpace(in.Server)
		if server == "" {
			server = "https://vault.bitwarden.com"
		}
		u, err := url.Parse(server)
		if err != nil || u.Host == "" || u.User != nil || (u.Scheme != "https" && !(u.Scheme == "http" && isLoopback(u.Hostname()))) {
			return s, errors.New("Vault server must use HTTPS or a loopback HTTP address")
		}
		if _, err = m.call(ctx, "", "config", "server", server); err != nil {
			return s, err
		}
		if strings.TrimSpace(in.Email) == "" {
			return s, errors.New("Email is required")
		}
		args = []string{"login", in.Email, "--raw", "--passwordenv", "ACRO_BW_PASSWORD", "--nointeraction"}
		if in.Code != "" {
			args = append(args, "--method", "0", "--code", in.Code)
		}
	}
	data, err := m.call(ctx, in.Password, args...)
	if err != nil {
		return s, err
	}
	token := strings.TrimSpace(string(data))
	decoded, decodeErr := base64.StdEncoding.DecodeString(token)
	if decodeErr != nil || len(decoded) < 16 {
		return s, errors.New("Bitwarden did not return a valid unlock session")
	}
	m.session = token
	m.touch()
	return m.status(ctx)
}
func (m *Manager) Lock() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.session = ""
	m.epoch++
	if m.timer != nil {
		m.timer.Stop()
	}
}
func (m *Manager) Logout(ctx context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.session = ""
	m.epoch++
	if m.timer != nil {
		m.timer.Stop()
	}
	_, err := m.call(ctx, "", "logout", "--nointeraction")
	return err
}
func (m *Manager) unlocked() error {
	if m.session == "" {
		return errors.New("Unlock the Bitwarden vault first")
	}
	m.touch()
	return nil
}
func Origin(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return "", errors.New("Enter an HTTP or HTTPS URL without embedded credentials")
	}
	host := strings.ToLower(u.Hostname())
	port := u.Port()
	if (u.Scheme == "https" && port == "443") || (u.Scheme == "http" && port == "80") {
		port = ""
	}
	if port != "" {
		host = net.JoinHostPort(host, port)
	} else if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	return u.Scheme + "://" + host, nil
}
func isLoopback(host string) bool {
	ip := net.ParseIP(host)
	return host == "localhost" || (ip != nil && ip.IsLoopback())
}
func metadata(v item) Account {
	a := Account{ID: v.ID, Name: v.Name, Origins: []string{}}
	if v.Login != nil {
		a.Username = v.Login.Username
		for _, uri := range v.Login.URIs {
			if uri.Match != nil && (*uri.Match == 4 || *uri.Match == 5) {
				continue
			}
			if o, err := Origin(uri.URI); err == nil {
				a.Origins = append(a.Origins, o)
			}
		}
	}
	return a
}

// Origin checks remain mandatory even when a Bitwarden rule is broader.
// Regex URI rules are unsupported and fail closed; Never is always excluded.
func allowed(v item, rawURL string) bool {
	if v.Type != 1 || v.Login == nil || v.DeletedDate != nil {
		return false
	}
	origin, err := Origin(rawURL)
	if err != nil {
		return false
	}
	for _, entry := range v.Login.URIs {
		if entry.Match != nil {
			switch *entry.Match {
			case 4, 5:
				continue
			case 3:
				if rawURL != entry.URI {
					continue
				}
			case 2:
				if !strings.HasPrefix(rawURL, entry.URI) {
					continue
				}
			}
		}
		if other, err := Origin(entry.URI); err == nil && other == origin {
			return true
		}
	}
	return false
}
func (m *Manager) List(ctx context.Context, rawURL string) ([]Account, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.unlocked(); err != nil {
		return nil, err
	}
	_, err := Origin(rawURL)
	if err != nil {
		return nil, err
	}
	data, err := m.call(ctx, "", "list", "items", "--nointeraction")
	if err != nil {
		return nil, err
	}
	var items []item
	if json.Unmarshal(data, &items) != nil {
		return nil, errors.New("Bitwarden returned invalid accounts")
	}
	out := []Account{}
	for _, v := range items {
		if allowed(v, rawURL) {
			out = append(out, metadata(v))
		}
	}
	return out, nil
}
func validID(id string) bool {
	if len(id) != 36 {
		return false
	}
	for i, c := range id {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if c != '-' {
				return false
			}
		} else if !strings.ContainsRune("0123456789abcdefABCDEF", c) {
			return false
		}
	}
	return true
}
func (m *Manager) get(ctx context.Context, id string) (item, error) {
	var v item
	if !validID(id) {
		return v, errors.New("Invalid Bitwarden item ID")
	}
	data, err := m.call(ctx, "", "get", "item", id, "--nointeraction")
	if err != nil {
		return v, err
	}
	if json.Unmarshal(data, &v) != nil || v.ID != id {
		return v, errors.New("Bitwarden returned an invalid account")
	}
	return v, nil
}
func (m *Manager) Credential(ctx context.Context, id, rawURL string) (Credential, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.unlocked(); err != nil {
		return Credential{}, err
	}
	_, err := Origin(rawURL)
	if err != nil {
		return Credential{}, err
	}
	v, err := m.get(ctx, id)
	if err != nil {
		return Credential{}, err
	}
	if !allowed(v, rawURL) {
		return Credential{}, errors.New("This account is not authorized for the current page origin")
	}
	return Credential{v.Login.Username, v.Login.Password}, nil
}
func (m *Manager) Save(ctx context.Context, in SaveInput) (Account, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.unlocked(); err != nil {
		return Account{}, err
	}
	origin, err := Origin(in.URL)
	if err != nil {
		return Account{}, err
	}
	if strings.TrimSpace(in.Name) == "" {
		return Account{}, errors.New("Account name is required")
	}
	// Editing an existing item retains fields the Acro editor does not expose.
	v := map[string]any{"type": 1, "name": in.Name, "login": map[string]any{"username": in.Username, "password": in.Password, "uris": []uri{{URI: origin}}}}
	args := []string{"create", "item"}
	if in.ID != "" {
		if !validID(in.ID) {
			return Account{}, errors.New("Invalid Bitwarden item ID")
		}
		data, err := m.call(ctx, "", "get", "item", in.ID, "--nointeraction")
		if err != nil {
			return Account{}, err
		}
		if json.Unmarshal(data, &v) != nil {
			return Account{}, errors.New("Bitwarden returned an invalid account")
		}
		var old item
		if json.Unmarshal(data, &old) != nil || old.ID != in.ID || !allowed(old, in.URL) {
			return Account{}, errors.New("This account is not authorized for the current page origin")
		}
		v["name"] = in.Name
		l, _ := v["login"].(map[string]any)
		l["username"] = in.Username
		if in.Password != "" {
			l["password"] = in.Password
		}
		args = []string{"edit", "item", in.ID}
	}
	if in.ID == "" && in.Password == "" {
		return Account{}, errors.New("Password is required for a new account")
	}
	encoded, _ := json.Marshal(v)
	// Pass encoded JSON through stdin, never process arguments.
	data, err := m.write(ctx, args, encoded)
	if err != nil {
		return Account{}, err
	}
	var saved item
	if json.Unmarshal(data, &saved) != nil || saved.ID == "" {
		return Account{}, errors.New("Bitwarden returned an invalid saved account")
	}
	return metadata(saved), nil
}

// write uses the CLI's stdin input for encoded item data.
func (m *Manager) write(ctx context.Context, args []string, data []byte) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "bw", append(args, "--nointeraction")...)
	for _, env := range os.Environ() {
		key, _, _ := strings.Cut(env, "=")
		if key != "BW_SESSION" && key != "BW_PASSWORD" && key != "ACRO_BW_PASSWORD" && key != "BITWARDENCLI_APPDATA_DIR" && key != "BITWARDENCLI_DEBUG" {
			cmd.Env = append(cmd.Env, env)
		}
	}
	cmd.Env = append(cmd.Env, "BITWARDENCLI_APPDATA_DIR="+filepath.Clean(m.dir), "BW_SESSION="+m.session)
	cmd.Stdin = strings.NewReader(base64.StdEncoding.EncodeToString(data))
	out, err := cmd.Output()
	if err != nil {
		return nil, errors.New("Bitwarden could not save the account")
	}
	return out, nil
}
func (m *Manager) Delete(ctx context.Context, id, rawURL string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.unlocked(); err != nil {
		return err
	}
	_, err := Origin(rawURL)
	if err != nil {
		return err
	}
	v, err := m.get(ctx, id)
	if err != nil {
		return err
	}
	if !allowed(v, rawURL) {
		return errors.New("This account is not authorized for the current page origin")
	}
	_, err = m.call(ctx, "", "delete", "item", id, "--nointeraction")
	return err
}
func (m *Manager) Sync(ctx context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.unlocked(); err != nil {
		return err
	}
	_, err := m.call(ctx, "", "sync", "--nointeraction")
	return err
}
