package capture

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// authority is Acro's local certificate authority: it signs the certificates
// the proxy presents for the sites a client asks for, which is what lets the
// proxy read HTTPS. The client must trust its root, which the app exports.
type authority struct {
	cert *x509.Certificate
	key  *ecdsa.PrivateKey
	pem  string

	mu    sync.Mutex
	leafs map[string]*tls.Certificate
}

// loadAuthority reads the CA from dir, creating it on first use so the root a
// client installed keeps signing after a restart.
func loadAuthority(dir string) (*authority, error) {
	certPath := filepath.Join(dir, "ca.pem")
	keyPath := filepath.Join(dir, "ca-key.pem")
	if data, err := os.ReadFile(certPath); err == nil {
		keyData, keyErr := os.ReadFile(keyPath)
		if keyErr != nil {
			return nil, fmt.Errorf("read CA key: %w", keyErr)
		}
		cert, key, err := parseCA(data, keyData)
		if err != nil {
			return nil, err
		}
		return &authority{cert: cert, key: key, pem: string(data), leafs: map[string]*tls.Certificate{}}, nil
	} else if !os.IsNotExist(err) {
		return nil, fmt.Errorf("read CA: %w", err)
	}
	a, certPEM, keyPEM, err := newAuthority()
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("create CA directory: %w", err)
	}
	// The key is private to this machine: only the user may read it.
	if err := os.WriteFile(keyPath, keyPEM, 0o600); err != nil {
		return nil, fmt.Errorf("write CA key: %w", err)
	}
	if err := os.WriteFile(certPath, certPEM, 0o644); err != nil {
		return nil, fmt.Errorf("write CA certificate: %w", err)
	}
	return a, nil
}

// newAuthority makes a root that is valid for ten years and signs everything.
func newAuthority() (*authority, []byte, []byte, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, nil, err
	}
	serial, err := randomSerial()
	if err != nil {
		return nil, nil, nil, err
	}
	now := time.Now()
	template := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: "Acro Local CA", Organization: []string{"Acro"}},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.AddDate(10, 0, 0),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature | x509.KeyUsageCRLSign,
		BasicConstraintsValid: true,
		IsCA:                  true,
		MaxPathLenZero:        true,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		return nil, nil, nil, err
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, nil, nil, err
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, nil, nil, err
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER})
	a := &authority{cert: cert, key: key, pem: string(certPEM), leafs: map[string]*tls.Certificate{}}
	return a, certPEM, keyPEM, nil
}

func parseCA(certPEM, keyPEM []byte) (*x509.Certificate, *ecdsa.PrivateKey, error) {
	block, _ := pem.Decode(certPEM)
	if block == nil {
		return nil, nil, fmt.Errorf("CA certificate is not PEM")
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return nil, nil, fmt.Errorf("parse CA certificate: %w", err)
	}
	keyBlock, _ := pem.Decode(keyPEM)
	if keyBlock == nil {
		return nil, nil, fmt.Errorf("CA key is not PEM")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(keyBlock.Bytes)
	if err != nil {
		return nil, nil, fmt.Errorf("parse CA key: %w", err)
	}
	key, ok := parsed.(*ecdsa.PrivateKey)
	if !ok {
		return nil, nil, fmt.Errorf("CA key is not ECDSA")
	}
	public, ok := cert.PublicKey.(*ecdsa.PublicKey)
	if !ok || !public.Equal(&key.PublicKey) {
		return nil, nil, fmt.Errorf("CA certificate does not match its private key")
	}
	if !cert.IsCA || !cert.BasicConstraintsValid || cert.KeyUsage&x509.KeyUsageCertSign == 0 {
		return nil, nil, fmt.Errorf("certificate cannot be used as a CA")
	}
	return cert, key, nil
}

// PEM is the root certificate clients install to trust the proxy.
func (a *authority) PEM() string { return a.pem }

// tlsConfig serves the certificate for host over a tunnel.
func (a *authority) tlsConfig(host string) (*tls.Config, error) {
	cert, err := a.leaf(host)
	if err != nil {
		return nil, err
	}
	return &tls.Config{
		Certificates: []tls.Certificate{*cert},
		MinVersion:   tls.VersionTLS12,
		// The proxy speaks HTTP/1.1 inside the tunnel, so it must not let the
		// client pick HTTP/2.
		NextProtos: []string{"http/1.1"},
	}, nil
}

// leaf returns the certificate for host, making and keeping it on first use.
func (a *authority) leaf(host string) (*tls.Certificate, error) {
	name := canonicalHost(host)
	a.mu.Lock()
	defer a.mu.Unlock()
	if cert, ok := a.leafs[name]; ok {
		return cert, nil
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	serial, err := randomSerial()
	if err != nil {
		return nil, err
	}
	now := time.Now()
	template := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: name, Organization: []string{"Acro"}},
		NotBefore:    now.Add(-time.Hour),
		NotAfter:     now.AddDate(1, 0, 0),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	if ip := net.ParseIP(name); ip != nil {
		template.IPAddresses = []net.IP{ip}
	} else {
		template.DNSNames = []string{name}
	}
	der, err := x509.CreateCertificate(rand.Reader, template, a.cert, &key.PublicKey, a.key)
	if err != nil {
		return nil, err
	}
	cert := &tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
	a.leafs[name] = cert
	return cert, nil
}

// caInstalled reports whether the OS trust store lists our root. It is only a
// hint for the UI: a client may also trust it per-profile.
func (a *authority) installed() bool {
	// Compare against the system roots if the platform exposes them simply;
	// otherwise the UI shows the certificate to install.
	return false
}

func randomSerial() (*big.Int, error) {
	limit := new(big.Int).Lsh(big.NewInt(1), 128)
	return rand.Int(rand.Reader, limit)
}

// canonicalHost strips a port and brackets from a CONNECT target.
func canonicalHost(host string) string {
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	return strings.TrimSuffix(strings.TrimPrefix(host, "["), "]")
}
