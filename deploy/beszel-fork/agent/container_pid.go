package agent

// gpu-monitoring fork addition (not upstream): the main process PID of every
// container as the host sees it (docker inspect State.Pid, the PID host ps,
// top and nsenter show), sent to the hub for the Containers page.
//
// The container list does not carry it, and an inspect per container every
// poll (a host runs 100+ containers, polled every few seconds) would be a lot
// of Docker API traffic for a number that almost never changes. The goal is to
// cost next to nothing, so:
//   - the cache holds one small struct per listed container (id -> PID plus two
//     timestamps), never an inspect response, and every round drops the entries
//     of containers that are no longer listed, so it cannot grow;
//   - an inspect is only made for a container that is new to the cache, was
//     (re)started after its PID was read (the list says "Up N seconds" for the
//     first minute), has a value older than pidCacheTTL (plus a per-container
//     jitter, so they do not all expire in one round) or failed earlier and
//     the retry delay has passed. In the steady state that is none: the round
//     does not allocate and makes no request;
//   - when something is due, one short-lived goroutine looks up at most
//     pidMaxInspectsPerRound containers (oldest first, a few at a time, each
//     with a short timeout) and ends. Data collection never waits for it: a
//     PID shows up one poll after the container is first seen. Failed or slow
//     look-ups are skipped and retried after pidRetryAfter, no retry storm.
//   - the response is decoded into a struct that only has State.Pid.

import (
	"context"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"log/slog"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/henrygd/beszel/internal/entities/container"
)

const (
	pidCacheTTL            = 5 * time.Minute
	pidCacheJitter         = time.Minute
	pidRetryAfter          = 30 * time.Second
	pidInspectTimeout      = time.Second
	pidMaxInspectsPerRound = 20
	pidInspectParallelism  = 4
)

// uptimeSecondsFromStatus returns the uptime in seconds when the status text
// has second precision, which Docker uses for the first minute after a start:
// "Up 5 seconds", "Up 1 second (healthy)", "Up Less than a second". It runs for
// every container every round, so it parses by hand and does not allocate.
func uptimeSecondsFromStatus(status string) (int, bool) {
	rest, ok := strings.CutPrefix(status, "Up ")
	if !ok {
		return 0, false
	}
	if strings.HasPrefix(rest, "Less than a second") {
		return 0, true
	}
	i := 0
	for i < len(rest) && rest[i] >= '0' && rest[i] <= '9' {
		i++
	}
	if i == 0 || i > 3 || !strings.HasPrefix(rest[i:], " second") {
		return 0, false
	}
	n, err := strconv.Atoi(rest[:i])
	return n, err == nil
}

// pidEntry is all that is kept per container (40 bytes plus the map key)
type pidEntry struct {
	fetchedAt   int64  // unix seconds of the last successful inspect, 0 = never
	retryAt     int64  // unix seconds, no new attempt before this, 0 = none
	expireAfter int64  // seconds a fetched PID is trusted (ttl plus this container's jitter)
	gen         uint32 // last round that listed the container
	pid         uint32
	failed      bool
}

type pidDue struct {
	id        string
	fetchedAt int64
}

type containerPidCache struct {
	mu      sync.Mutex
	entries map[string]*pidEntry // key: short container id
	gen     uint32
	due     []pidDue // reused between rounds

	// inspect returns State.Pid of a container, 0 when it is not running
	inspect func(ctx context.Context, id string) (uint32, error)
	now     func() time.Time

	ttl         time.Duration
	jitterMax   time.Duration
	maxPerRound int

	running  atomic.Bool    // a look-up batch is in progress
	wg       sync.WaitGroup // lets tests wait for a batch
	inspects atomic.Int64   // total inspect calls
}

func newContainerPidCache(inspect func(ctx context.Context, id string) (uint32, error)) *containerPidCache {
	return &containerPidCache{
		entries:     make(map[string]*pidEntry),
		inspect:     inspect,
		now:         time.Now,
		ttl:         pidCacheTTL,
		jitterMax:   pidCacheJitter,
		maxPerRound: pidMaxInspectsPerRound,
	}
}

// jitterFor spreads expiry over jitterMax, the same for a given container id
func (c *containerPidCache) jitterFor(id string) time.Duration {
	if c.jitterMax <= 0 {
		return 0
	}
	h := fnv.New32a()
	_, _ = h.Write([]byte(id))
	return time.Duration(h.Sum32()) % c.jitterMax
}

// beginRound starts a new pass over the container list
func (c *containerPidCache) beginRound() {
	c.mu.Lock()
	c.gen++
	c.due = c.due[:0]
	c.mu.Unlock()
}

// note registers one listed container, id is its short id, and queues it for a
// look-up if its PID is unknown or may have changed
func (c *containerPidCache) note(id, state, status string) {
	now := c.now().Unix()
	c.mu.Lock()
	defer c.mu.Unlock()
	// a stopped, created or restarting container has no PID to show
	if state != "" && state != "running" && state != "paused" {
		delete(c.entries, id)
		return
	}
	e, ok := c.entries[id]
	if !ok {
		c.entries[id] = &pidEntry{gen: c.gen, expireAfter: int64((c.ttl + c.jitterFor(id)) / time.Second)}
		c.due = append(c.due, pidDue{id: id})
		return
	}
	e.gen = c.gen
	switch {
	case now < e.retryAt:
		// backing off after a failure or an empty answer
	case e.fetchedAt == 0 || e.failed || e.pid == 0:
		c.due = append(c.due, pidDue{id: id, fetchedAt: e.fetchedAt})
	case now-e.fetchedAt >= e.expireAfter:
		c.due = append(c.due, pidDue{id: id, fetchedAt: e.fetchedAt})
	default:
		// started after the cached value was read: it was restarted
		if secs, ok := uptimeSecondsFromStatus(status); ok && e.fetchedAt < now-int64(secs+2) {
			c.due = append(c.due, pidDue{id: id, fetchedAt: e.fetchedAt})
		}
	}
}

// endRound forgets containers that are no longer listed and, if something is
// due, starts a look-up batch in the background (never more than one at a time)
func (c *containerPidCache) endRound() {
	c.mu.Lock()
	for id, e := range c.entries {
		if e.gen != c.gen {
			delete(c.entries, id)
		}
	}
	if len(c.due) == 0 || c.running.Load() {
		c.mu.Unlock()
		return
	}
	// never-fetched containers first (fetchedAt 0), then the oldest
	if len(c.due) > 1 {
		sort.SliceStable(c.due, func(i, j int) bool { return c.due[i].fetchedAt < c.due[j].fetchedAt })
	}
	n := len(c.due)
	if c.maxPerRound > 0 && n > c.maxPerRound {
		n = c.maxPerRound
	}
	ids := make([]string, n)
	for i := range ids {
		ids[i] = c.due[i].id
	}
	c.mu.Unlock()

	if !c.running.CompareAndSwap(false, true) {
		return
	}
	c.wg.Add(1)
	go c.lookUp(ids)
}

// refresh is beginRound, note for each container and endRound in one call
func (c *containerPidCache) refresh(ctrs []*container.ApiInfo) {
	c.beginRound()
	for _, ctr := range ctrs {
		c.note(ctr.IdShort, ctr.State, ctr.Status)
	}
	c.endRound()
}

// wait blocks until the running look-up batch, if any, has finished (tests)
func (c *containerPidCache) wait() { c.wg.Wait() }

// pid returns the cached PID of a container, 0 when unknown
func (c *containerPidCache) pid(id string) uint32 {
	c.mu.Lock()
	defer c.mu.Unlock()
	if e := c.entries[id]; e != nil {
		return e.pid
	}
	return 0
}

func (c *containerPidCache) lookUp(ids []string) {
	defer c.wg.Done()
	defer c.running.Store(false)

	sem := make(chan struct{}, min(pidInspectParallelism, len(ids)))
	var wg sync.WaitGroup
	for _, id := range ids {
		sem <- struct{}{}
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			defer func() { <-sem }()
			ctx, cancel := context.WithTimeout(context.Background(), pidInspectTimeout)
			defer cancel()
			c.inspects.Add(1)
			pid, err := c.inspect(ctx, id)
			at := c.now().Unix()
			c.mu.Lock()
			defer c.mu.Unlock()
			e := c.entries[id]
			if e == nil {
				return // the container went away meanwhile
			}
			switch {
			case err != nil:
				// keep what we had: a failed look-up must not blank a known PID
				e.failed = true
				e.retryAt = at + int64(pidRetryAfter/time.Second)
				slog.Debug("container PID inspect failed", "id", id, "err", err)
			case pid == 0:
				e.pid, e.fetchedAt, e.failed = 0, at, false
				e.retryAt = at + int64(pidRetryAfter/time.Second)
			default:
				e.pid, e.fetchedAt, e.failed, e.retryAt = pid, at, false, 0
			}
		}(id)
	}
	wg.Wait()
	c.mu.Lock()
	cached := len(c.entries)
	c.mu.Unlock()
	slog.Debug("container PID inspects", "count", len(ids), "cached", cached)
}

// inspectPid reads State.Pid from the Docker Engine API
func (dm *dockerManager) inspectPid(ctx context.Context, containerID string) (uint32, error) {
	endpoint, err := buildDockerContainerEndpoint(containerID, "json", nil)
	if err != nil {
		return 0, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return 0, err
	}
	resp, err := dm.client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("container inspect failed: %s", resp.Status)
	}
	// only State.Pid is decoded, the rest of the response is skipped
	var info struct {
		State struct {
			Pid int `json:"Pid"`
		} `json:"State"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil {
		return 0, err
	}
	if info.State.Pid < 0 {
		return 0, nil
	}
	return uint32(info.State.Pid), nil
}
