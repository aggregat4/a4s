package httpapi

import "sync"

// Broadcaster manages Server-Sent Event connections per user.
type Broadcaster struct {
	mu    sync.RWMutex
	conns map[string][]chan struct{}
}

// NewBroadcaster creates a new in-memory broadcaster.
func NewBroadcaster() *Broadcaster {
	return &Broadcaster{conns: make(map[string][]chan struct{})}
}

// Add registers a new notification channel for the given user.
func (b *Broadcaster) Add(userID string) chan struct{} {
	b.mu.Lock()
	defer b.mu.Unlock()
	ch := make(chan struct{}, 1)
	b.conns[userID] = append(b.conns[userID], ch)
	return ch
}

// Remove deregisters a notification channel for the given user.
func (b *Broadcaster) Remove(userID string, ch chan struct{}) {
	b.mu.Lock()
	defer b.mu.Unlock()
	arr := b.conns[userID]
	for i, c := range arr {
		if c == ch {
			b.conns[userID] = append(arr[:i], arr[i+1:]...)
			break
		}
	}
	close(ch)
}

// Notify sends a signal to all active connections for the given user.
func (b *Broadcaster) Notify(userID string) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	for _, ch := range b.conns[userID] {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}
