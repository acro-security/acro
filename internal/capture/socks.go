package capture

import (
	"bufio"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"strconv"
	"time"
)

// SOCKS5 support, so a profile configured as SOCKS5 works as well as an HTTP
// proxy. The grammar is RFC 1928: a greeting, an optional username and password,
// then one CONNECT request per connection.

// tlsRecordHandshake is the first byte of a TLS handshake record, as a client
// inside a SOCKS tunnel starts one.
const tlsRecordHandshake = 0x16

const (
	socksVersion           = 0x05
	socksAuthNone          = 0x00
	socksAuthRejected      = 0xff
	socksCmdConnect        = 0x01
	socksAtypIPv4          = 0x01
	socksAtypDomain        = 0x03
	socksAtypIPv6          = 0x04
	socksRepSuccess        = 0x00
	socksRepCmdUnsupported = 0x07
)

// serveSOCKS answers one SOCKS5 connection whose greeting byte was already read.
// The proxy serves HTTP and SOCKS on one port, because a client chooses only an
// address and a port; its profile type decides the protocol.
func (p *Proxy) serveSOCKS(conn *peekedConn) {
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(30 * time.Second))
	// peekFirstByte read the greeting's version to classify the connection, and
	// Read replays it; consume it here so the greeting parses in order.
	var version [1]byte
	if _, err := io.ReadFull(conn, version[:]); err != nil {
		return
	}
	if version[0] != socksVersion {
		return
	}
	var count [1]byte
	if _, err := io.ReadFull(conn, count[:]); err != nil {
		return
	}
	methods := make([]byte, int(count[0]))
	if _, err := io.ReadFull(conn, methods); err != nil {
		return
	}
	// No authentication: Acro listens on loopback only and a proxy password
	// would be a credential the app also has to store.
	if !containsByte(methods, socksAuthNone) {
		_, _ = conn.Write([]byte{socksVersion, socksAuthRejected})
		return
	}
	if _, err := conn.Write([]byte{socksVersion, socksAuthNone}); err != nil {
		return
	}

	// One request: version, command, reserved, address type.
	var request [4]byte
	if _, err := io.ReadFull(conn, request[:]); err != nil {
		return
	}
	if request[0] != socksVersion || request[2] != 0 {
		return
	}
	host, err := readSOCKSAddress(conn, request[3])
	if err != nil {
		return
	}
	var portBytes [2]byte
	if _, err := io.ReadFull(conn, portBytes[:]); err != nil {
		return
	}
	port := int(binary.BigEndian.Uint16(portBytes[:]))

	if request[1] != socksCmdConnect {
		_, _ = conn.Write([]byte{socksVersion, socksRepCmdUnsupported, 0, socksAtypIPv4, 0, 0, 0, 0, 0, 0})
		return
	}
	target := net.JoinHostPort(host, strconv.Itoa(port))

	// Report success before the tunnel opens: a client sends its TLS greeting
	// as soon as it reads this, and waiting for the target would deadlock.
	if _, err := conn.Write([]byte{socksVersion, socksRepSuccess, 0, socksAtypIPv4, 0, 0, 0, 0, 0, 0}); err != nil {
		return
	}
	// A SOCKS tunnel carries raw bytes. Browsers with an HTTPS profile speak
	// TLS inside it, which is the case that matters: terminate it and record the
	// requests, exactly as an HTTP CONNECT tunnel does. A plaintext client on a
	// SOCKS profile is unusual and gets forwarded as well, through the same
	// reader, because the two are told apart by the first record.
	reader := bufio.NewReader(conn)
	first, err := reader.Peek(1)
	if err != nil {
		return
	}
	_ = conn.SetDeadline(time.Time{})
	if first[0] == tlsRecordHandshake {
		p.tunnelTLS(conn.ctx, reader, conn, target)
	} else {
		p.serveTunnel(conn.ctx, &readerConn{Conn: conn, r: reader}, target, "http")
	}
}

// readSOCKSAddress reads the request's address, as its type says.
func readSOCKSAddress(conn net.Conn, atyp byte) (string, error) {
	switch atyp {
	case socksAtypIPv4:
		var ip [4]byte
		if _, err := io.ReadFull(conn, ip[:]); err != nil {
			return "", err
		}
		return net.IP(ip[:]).String(), nil
	case socksAtypIPv6:
		var ip [16]byte
		if _, err := io.ReadFull(conn, ip[:]); err != nil {
			return "", err
		}
		return net.IP(ip[:]).String(), nil
	case socksAtypDomain:
		var length [1]byte
		if _, err := io.ReadFull(conn, length[:]); err != nil {
			return "", err
		}
		name := make([]byte, int(length[0]))
		if _, err := io.ReadFull(conn, name); err != nil {
			return "", err
		}
		return string(name), nil
	}
	return "", fmt.Errorf("unknown SOCKS address type %d", atyp)
}

func containsByte(b []byte, want byte) bool {
	for _, v := range b {
		if v == want {
			return true
		}
	}
	return false
}
