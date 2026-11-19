package capture

import (
	"bufio"
	"context"
	"io"
	"net"
	"sync"
	"time"
)

// splitListener classifies each connection independently. A client that sends
// no greeting must never hold the HTTP server's Accept loop hostage.
type splitListener struct {
	net.Listener
	ctx         context.Context
	onSOCKS     func(*peekedConn)
	ready       chan net.Conn
	done        chan struct{}
	mu          sync.Mutex
	closed      bool
	connections map[*trackedConn]struct{}
}

func newSplitListener(ctx context.Context, listener net.Listener, onSOCKS func(*peekedConn)) *splitListener {
	l := &splitListener{Listener: listener, ctx: ctx, onSOCKS: onSOCKS, ready: make(chan net.Conn), done: make(chan struct{}), connections: map[*trackedConn]struct{}{}}
	go l.accept()
	return l
}

func (l *splitListener) accept() {
	for {
		conn, err := l.Listener.Accept()
		if err != nil {
			_ = l.Close()
			return
		}
		tracked := &trackedConn{Conn: conn, owner: l}
		l.mu.Lock()
		if l.closed {
			l.mu.Unlock()
			_ = conn.Close()
			return
		}
		l.connections[tracked] = struct{}{}
		l.mu.Unlock()
		go l.classify(tracked)
	}
}

func (l *splitListener) classify(conn *trackedConn) {
	_ = conn.SetReadDeadline(time.Now().Add(30 * time.Second))
	wrapped, err := peekFirstByte(conn)
	if err != nil {
		_ = conn.Close()
		return
	}
	_ = conn.SetReadDeadline(time.Time{})
	wrapped.ctx = l.ctx
	if wrapped.socks {
		defer wrapped.Close()
		l.onSOCKS(wrapped)
		return
	}
	select {
	case l.ready <- wrapped:
	case <-l.done:
		_ = conn.Close()
	}
}

func (l *splitListener) Accept() (net.Conn, error) {
	select {
	case conn := <-l.ready:
		return conn, nil
	case <-l.done:
		return nil, net.ErrClosed
	}
}
func (l *splitListener) Close() error {
	l.mu.Lock()
	if l.closed {
		l.mu.Unlock()
		return nil
	}
	l.closed = true
	close(l.done)
	connections := make([]*trackedConn, 0, len(l.connections))
	for conn := range l.connections {
		connections = append(connections, conn)
	}
	l.mu.Unlock()
	err := l.Listener.Close()
	for _, conn := range connections {
		_ = conn.Close()
	}
	return err
}

// Connections remain registered after HTTP hijacking and during SOCKS/TLS
// handshakes, so Stop closes every accepted socket, not just HTTP keep-alives.
type trackedConn struct {
	net.Conn
	owner *splitListener
	once  sync.Once
	err   error
}

func (c *trackedConn) Close() error {
	c.once.Do(func() { c.err = c.Conn.Close(); c.owner.mu.Lock(); delete(c.owner.connections, c); c.owner.mu.Unlock() })
	return c.err
}

type peekedConn struct {
	net.Conn
	ctx   context.Context
	socks bool
	first byte
	read  bool
}

func peekFirstByte(conn net.Conn) (*peekedConn, error) {
	var b [1]byte
	if _, err := io.ReadFull(conn, b[:]); err != nil {
		return nil, err
	}
	return &peekedConn{Conn: conn, socks: b[0] == socksVersion, first: b[0]}, nil
}
func (p *peekedConn) Read(b []byte) (int, error) {
	if len(b) == 0 {
		return 0, nil
	}
	if !p.read {
		b[0] = p.first
		p.read = true
		return 1, nil
	}
	return p.Conn.Read(b)
}

// singleListener gives net/http one tunnel and unblocks Serve when it closes.
// net/http owns response framing, HEAD/204 behavior, keep-alive and cancellation.
type singleListener struct {
	conn     net.Conn
	accepted bool
	done     chan struct{}
	once     sync.Once
}

func newSingleListener(conn net.Conn) *singleListener {
	return &singleListener{conn: conn, done: make(chan struct{})}
}
func (l *singleListener) Accept() (net.Conn, error) {
	if !l.accepted {
		l.accepted = true
		return &singleConn{Conn: l.conn, listener: l}, nil
	}
	<-l.done
	return nil, net.ErrClosed
}
func (l *singleListener) Close() error {
	var err error
	l.once.Do(func() { close(l.done); err = l.conn.Close() })
	return err
}
func (l *singleListener) Addr() net.Addr { return l.conn.LocalAddr() }

type singleConn struct {
	net.Conn
	listener *singleListener
}

func (c *singleConn) Close() error { return c.listener.Close() }

type readerConn struct {
	net.Conn
	r *bufio.Reader
}

func (c *readerConn) Read(b []byte) (int, error) { return c.r.Read(b) }
