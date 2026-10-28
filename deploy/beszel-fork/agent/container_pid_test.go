//go:build testing

package agent

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/henrygd/beszel/internal/entities/container"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fakeInspector stands in for the Docker API: a PID per container id, an error
// per id, and a count of calls per id.
type fakeInspector struct {
	mu    sync.Mutex
	pids  map[string]uint32
	errs  map[string]error
	calls map[string]int
}

func newFakeInspector(pids map[string]uint32) *fakeInspector {
	return &fakeInspector{pids: pids, errs: map[string]error{}, calls: map[string]int{}}
}

func (f *fakeInspector) inspect(_ context.Context, id string) (uint32, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls[id]++
	if err := f.errs[id]; err != nil {
		return 0, err
	}
	return f.pids[id], nil
}

func (f *fakeInspector) total() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, c := range f.calls {
		n += c
	}
	return n
}

func (f *fakeInspector) set(id string, pid uint32) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.pids[id] = pid
}

type pidTestClock struct{ t time.Time }

func (c *pidTestClock) now() time.Time          { return c.t }
func (c *pidTestClock) advance(d time.Duration) { c.t = c.t.Add(d) }

func newTestPidCache(f *fakeInspector, clock *pidTestClock) *containerPidCache {
	c := newContainerPidCache(f.inspect)
	c.now = clock.now
	c.jitterMax = 0
	return c
}

// settle runs a round, waits for the background look-up and returns every known PID
func settle(c *containerPidCache, list []*container.ApiInfo) map[string]uint32 {
	c.refresh(list)
	c.wait()
	c.mu.Lock()
	defer c.mu.Unlock()
	out := map[string]uint32{}
	for id, e := range c.entries {
		if e.pid != 0 {
			out[id] = e.pid
		}
	}
	return out
}

func pidCtr(id, state, status string) *container.ApiInfo {
	return &container.ApiInfo{IdShort: id, State: state, Status: status}
}

func TestPidCacheInspectsNewContainersOnce(t *testing.T) {
	f := newFakeInspector(map[string]uint32{"aaaaaaaaaaaa": 101, "bbbbbbbbbbbb": 202})
	clock := &pidTestClock{t: time.Unix(1_000_000, 0)}
	c := newTestPidCache(f, clock)
	list := []*container.ApiInfo{pidCtr("aaaaaaaaaaaa", "running", "Up 3 hours"), pidCtr("bbbbbbbbbbbb", "running", "Up 2 days")}

	pids := settle(c, list)
	assert.Equal(t, map[string]uint32{"aaaaaaaaaaaa": 101, "bbbbbbbbbbbb": 202}, pids)
	assert.Equal(t, 2, f.total())

	// every later poll is served from the cache
	for range 5 {
		clock.advance(5 * time.Second)
		assert.Equal(t, pids, settle(c, list))
	}
	assert.Equal(t, 2, f.total())
}

func TestPidCacheRefreshesAfterTTL(t *testing.T) {
	f := newFakeInspector(map[string]uint32{"aaaaaaaaaaaa": 101})
	clock := &pidTestClock{t: time.Unix(1_000_000, 0)}
	c := newTestPidCache(f, clock)
	list := []*container.ApiInfo{pidCtr("aaaaaaaaaaaa", "running", "Up 3 hours")}

	settle(c, list)
	clock.advance(c.ttl - time.Second)
	settle(c, list)
	assert.Equal(t, 1, f.total(), "not yet expired")

	f.set("aaaaaaaaaaaa", 999)
	clock.advance(2 * time.Second)
	assert.Equal(t, uint32(999), settle(c, list)["aaaaaaaaaaaa"])
	assert.Equal(t, 2, f.total())
}

func TestPidCacheJitterSpreadsExpiry(t *testing.T) {
	f := newFakeInspector(map[string]uint32{})
	clock := &pidTestClock{t: time.Unix(1_000_000, 0)}
	c := newContainerPidCache(f.inspect)
	c.now = clock.now
	seen := map[time.Duration]bool{}
	for i := range 20 {
		j := c.jitterFor(fmt.Sprintf("container%03d", i))
		assert.GreaterOrEqual(t, j, time.Duration(0))
		assert.Less(t, j, c.jitterMax)
		seen[j] = true
	}
	assert.Greater(t, len(seen), 10, "containers should not all expire together")
	assert.Equal(t, c.jitterFor("same"), c.jitterFor("same"))
}

func TestPidCacheNoticesRestart(t *testing.T) {
	const id = "aaaaaaaaaaaa"
	f := newFakeInspector(map[string]uint32{id: 101})
	clock := &pidTestClock{t: time.Unix(1_000_000, 0)}
	c := newTestPidCache(f, clock)

	settle(c, []*container.ApiInfo{pidCtr(id, "running", "Up 3 hours")})
	require.Equal(t, 1, f.total())

	// restarted 20 seconds ago: new PID, the cached one is older than the start
	clock.advance(60 * time.Second)
	f.set(id, 202)
	pids := settle(c, []*container.ApiInfo{pidCtr(id, "running", "Up 20 seconds")})
	assert.Equal(t, uint32(202), pids[id])
	assert.Equal(t, 2, f.total())

	// the following polls in that first minute do not inspect again
	for range 4 {
		clock.advance(5 * time.Second)
		pids = settle(c, []*container.ApiInfo{pidCtr(id, "running", "Up 30 seconds")})
	}
	assert.Equal(t, uint32(202), pids[id])
	assert.Equal(t, 2, f.total())

	// "Up Less than a second" counts as a start too
	clock.advance(10 * time.Second)
	f.set(id, 303)
	assert.Equal(t, uint32(303), settle(c, []*container.ApiInfo{pidCtr(id, "running", "Up Less than a second")})[id])
}

func TestPidCacheFreshlyStartedContainerIsNotRestart(t *testing.T) {
	const id = "aaaaaaaaaaaa"
	f := newFakeInspector(map[string]uint32{id: 101})
	clock := &pidTestClock{t: time.Unix(1_000_000, 0)}
	c := newTestPidCache(f, clock)

	// first seen 8 seconds after it started
	settle(c, []*container.ApiInfo{pidCtr(id, "running", "Up 8 seconds")})
	clock.advance(5 * time.Second)
	settle(c, []*container.ApiInfo{pidCtr(id, "running", "Up 13 seconds")})
	assert.Equal(t, 1, f.total())
}

func TestPidCacheStoppedAndEmptyContainers(t *testing.T) {
	f := newFakeInspector(map[string]uint32{"aaaaaaaaaaaa": 101, "bbbbbbbbbbbb": 0})
	clock := &pidTestClock{t: time.Unix(1_000_000, 0)}
	c := newTestPidCache(f, clock)

	// exited and restarting containers are not inspected and get no PID
	pids := settle(c, []*container.ApiInfo{pidCtr("cccccccccccc", "exited", "Exited (0) 2 hours ago"), pidCtr("dddddddddddd", "restarting", "Restarting")})
	assert.Empty(t, pids)
	assert.Equal(t, 0, f.total())

	// running per the list but Pid 0 per inspect: nothing shown, retried after the delay
	list := []*container.ApiInfo{pidCtr("aaaaaaaaaaaa", "running", "Up 1 hour"), pidCtr("bbbbbbbbbbbb", "running", "Up 1 hour")}
	pids = settle(c, list)
	assert.Equal(t, map[string]uint32{"aaaaaaaaaaaa": 101}, pids)
	assert.Equal(t, 2, f.total())
	clock.advance(10 * time.Second)
	settle(c, list)
	assert.Equal(t, 2, f.total(), "empty result is not retried every poll")
	f.set("bbbbbbbbbbbb", 303)
	clock.advance(pidRetryAfter)
	assert.Equal(t, uint32(303), settle(c, list)["bbbbbbbbbbbb"])

	// a container that stops loses its PID
	list[0] = pidCtr("aaaaaaaaaaaa", "exited", "Exited (1) 1 second ago")
	assert.NotContains(t, settle(c, list), "aaaaaaaaaaaa")
}

func TestPidCacheCapsInspectsPerRound(t *testing.T) {
	pids := map[string]uint32{}
	var list []*container.ApiInfo
	for i := range 60 {
		id := fmt.Sprintf("%012d", i)
		pids[id] = uint32(1000 + i)
		list = append(list, pidCtr(id, "running", "Up 2 hours"))
	}
	f := newFakeInspector(pids)
	clock := &pidTestClock{t: time.Unix(1_000_000, 0)}
	c := newTestPidCache(f, clock)
	c.maxPerRound = 25

	assert.Len(t, settle(c, list), 25)
	assert.Equal(t, 25, f.total())
	assert.Len(t, settle(c, list), 50)
	assert.Equal(t, 50, f.total())
	assert.Len(t, settle(c, list), 60)
	assert.Equal(t, 60, f.total())
	// steady state: nothing to do
	for range 3 {
		clock.advance(5 * time.Second)
		settle(c, list)
	}
	assert.Equal(t, 60, f.total())
	for id := range pids {
		assert.Equal(t, 1, f.calls[id], "each container inspected once: %s", id)
	}
}

func TestPidCacheNewContainersBeforeExpiredOnes(t *testing.T) {
	f := newFakeInspector(map[string]uint32{"aaaaaaaaaaaa": 1, "bbbbbbbbbbbb": 2, "cccccccccccc": 3})
	clock := &pidTestClock{t: time.Unix(1_000_000, 0)}
	c := newTestPidCache(f, clock)
	c.maxPerRound = 1

	settle(c, []*container.ApiInfo{pidCtr("aaaaaaaaaaaa", "running", "Up 1 day")})
	clock.advance(c.ttl + time.Second)
	// "a" has expired, "b" is new, one inspect per round: the new one goes first
	list := []*container.ApiInfo{pidCtr("aaaaaaaaaaaa", "running", "Up 1 day"), pidCtr("bbbbbbbbbbbb", "running", "Up 1 day")}
	pids := settle(c, list)
	assert.Equal(t, 1, f.calls["bbbbbbbbbbbb"])
	assert.Equal(t, 1, f.calls["aaaaaaaaaaaa"], "the expired one waits for the next round")
	assert.Contains(t, pids, "bbbbbbbbbbbb")
	assert.Contains(t, pids, "aaaaaaaaaaaa", "and keeps its old value meanwhile")
	settle(c, list)
	assert.Equal(t, 2, f.calls["aaaaaaaaaaaa"])
}

func TestPidCacheFailureDoesNotAffectOthers(t *testing.T) {
	f := newFakeInspector(map[string]uint32{"aaaaaaaaaaaa": 101, "bbbbbbbbbbbb": 202})
	f.errs["bbbbbbbbbbbb"] = errors.New("boom")
	clock := &pidTestClock{t: time.Unix(1_000_000, 0)}
	c := newTestPidCache(f, clock)
	list := []*container.ApiInfo{pidCtr("aaaaaaaaaaaa", "running", "Up 1 hour"), pidCtr("bbbbbbbbbbbb", "running", "Up 1 hour")}

	pids := settle(c, list)
	assert.Equal(t, map[string]uint32{"aaaaaaaaaaaa": 101}, pids)

	// retried only after the delay, then it works
	clock.advance(5 * time.Second)
	settle(c, list)
	assert.Equal(t, 1, f.calls["bbbbbbbbbbbb"])
	delete(f.errs, "bbbbbbbbbbbb")
	clock.advance(pidRetryAfter)
	assert.Equal(t, uint32(202), settle(c, list)["bbbbbbbbbbbb"])
}

func TestPidCacheFailedRefreshKeepsKnownPid(t *testing.T) {
	const id = "aaaaaaaaaaaa"
	f := newFakeInspector(map[string]uint32{id: 101})
	clock := &pidTestClock{t: time.Unix(1_000_000, 0)}
	c := newTestPidCache(f, clock)
	list := []*container.ApiInfo{pidCtr(id, "running", "Up 1 hour")}

	settle(c, list)
	f.errs[id] = errors.New("docker busy")
	clock.advance(c.ttl + time.Second)
	assert.Equal(t, uint32(101), settle(c, list)[id], "a failed look-up must not blank a known PID")
}

func TestPidCacheForgetsRemovedContainers(t *testing.T) {
	const id = "aaaaaaaaaaaa"
	f := newFakeInspector(map[string]uint32{id: 101})
	clock := &pidTestClock{t: time.Unix(1_000_000, 0)}
	c := newTestPidCache(f, clock)

	settle(c, []*container.ApiInfo{pidCtr(id, "running", "Up 1 hour")})
	assert.Empty(t, settle(c, nil))
	f.set(id, 555)
	assert.Equal(t, uint32(555), settle(c, []*container.ApiInfo{pidCtr(id, "running", "Up 1 hour")})[id])
	assert.Equal(t, 2, f.calls[id])
}

func TestUptimeSecondsFromStatus(t *testing.T) {
	for status, want := range map[string]struct {
		n  int
		ok bool
	}{
		"Up 5 seconds":                  {5, true},
		"Up 1 second":                   {1, true},
		"Up Less than a second":         {0, true},
		"Up 59 seconds (healthy)":       {59, true},
		"Up 5 seconds ago":              {5, true},
		"Up About a minute":             {0, false},
		"Up 2 minutes":                  {0, false},
		"Up 3 hours (health: starting)": {0, false},
		"Exited (0) 5 seconds ago":      {0, false},
		"":                              {0, false},
	} {
		n, ok := uptimeSecondsFromStatus(status)
		assert.Equal(t, want.ok, ok, status)
		assert.Equal(t, want.n, n, status)
	}
}

// inspectPid reads State.Pid from the Docker API and treats a missing or
// failed answer as an error, not as PID 0
func TestInspectPid(t *testing.T) {
	answer := func(code int, body string) *dockerManager {
		return &dockerManager{client: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			assert.True(t, strings.HasSuffix(req.URL.Path, "/containers/abc123def456/json"), req.URL.Path)
			return &http.Response{StatusCode: code, Status: fmt.Sprintf("%d", code), Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}, nil
		})}}
	}
	ctx := context.Background()

	pid, err := answer(200, `{"Id":"abc","State":{"Status":"running","Pid":48213},"Config":{"Env":["A=b"]}}`).inspectPid(ctx, "abc123def456")
	require.NoError(t, err)
	assert.Equal(t, uint32(48213), pid)

	pid, err = answer(200, `{"State":{"Status":"exited","Pid":0}}`).inspectPid(ctx, "abc123def456")
	require.NoError(t, err)
	assert.Equal(t, uint32(0), pid)

	_, err = answer(404, `{"message":"No such container"}`).inspectPid(ctx, "abc123def456")
	assert.Error(t, err)
	_, err = answer(200, `not json`).inspectPid(ctx, "abc123def456")
	assert.Error(t, err)
	_, err = answer(200, `{}`).inspectPid(ctx, "../etc")
	assert.Error(t, err, "container ids are validated like the other endpoints")
}

// the look-up runs in the background: a round never waits for Docker, only one
// batch runs at a time, and nothing is asked twice
func TestPidCacheLookUpDoesNotBlockTheRound(t *testing.T) {
	release := make(chan struct{})
	var mu sync.Mutex
	calls := 0
	c := newContainerPidCache(func(_ context.Context, id string) (uint32, error) {
		mu.Lock()
		calls++
		mu.Unlock()
		<-release
		return 7, nil
	})
	list := []*container.ApiInfo{pidCtr("aaaaaaaaaaaa", "running", "Up 1 hour"), pidCtr("bbbbbbbbbbbb", "running", "Up 1 hour")}

	done := make(chan struct{})
	go func() {
		c.refresh(list)
		c.refresh(list) // a batch is still running: no second one is started
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("a round must not wait for the Docker look-up")
	}
	assert.Equal(t, uint32(0), c.pid("aaaaaaaaaaaa"), "not known until the batch is done")

	close(release)
	c.wait()
	mu.Lock()
	assert.Equal(t, 2, calls, "each container asked once")
	mu.Unlock()
	assert.Equal(t, uint32(7), c.pid("aaaaaaaaaaaa"))
}

// in the steady state a round does not allocate and does not call Docker; the
// cache has exactly one small entry per listed container
func TestPidCacheSteadyStateIsFree(t *testing.T) {
	pids := map[string]uint32{}
	var list []*container.ApiInfo
	for i := range 150 {
		id := fmt.Sprintf("%012d", i)
		pids[id] = uint32(100 + i)
		list = append(list, pidCtr(id, "running", "Up 3 hours (healthy)"))
	}
	f := newFakeInspector(pids)
	c := newContainerPidCache(f.inspect)
	c.maxPerRound = 50
	for range 3 {
		settle(c, list)
	}
	require.Equal(t, 150, f.total())
	assert.Len(t, c.entries, 150)

	before := f.total()
	allocs := testing.AllocsPerRun(50, func() { c.refresh(list) })
	assert.Equal(t, before, f.total(), "no inspect in the steady state")
	assert.Equal(t, float64(0), allocs, "no allocation per round")

	// containers that disappear leave the cache at once, it never grows
	settle(c, list[:100])
	assert.Len(t, c.entries, 100)
	settle(c, nil)
	assert.Empty(t, c.entries)
}

// cost of one round over 150 containers once everything is cached
func BenchmarkPidCacheSteadyRound(b *testing.B) {
	pids := map[string]uint32{}
	var list []*container.ApiInfo
	for i := range 150 {
		id := fmt.Sprintf("%012d", i)
		pids[id] = uint32(100 + i)
		list = append(list, pidCtr(id, "running", "Up 3 hours (healthy)"))
	}
	c := newContainerPidCache(newFakeInspector(pids).inspect)
	c.maxPerRound = 50
	for range 3 {
		settle(c, list)
	}
	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		c.refresh(list)
	}
}

// end to end through getDockerStats against a fake Docker API: the PID reaches
// the stats one poll after the container shows up, each container is inspected
// once, and excluded containers are not inspected at all
func TestGetDockerStatsReportsMainPid(t *testing.T) {
	var inspects atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.EscapedPath()
		switch {
		case path == "/containers/json":
			fmt.Fprint(w, `[
				{"Id":"aaaaaaaaaaaa1111","Names":["/web"],"Image":"web:1","State":"running","Status":"Up 3 days"},
				{"Id":"bbbbbbbbbbbb2222","Names":["/db"],"Image":"db:1","State":"running","Status":"Up 3 days"},
				{"Id":"cccccccccccc3333","Names":["/hidden-1"],"Image":"hidden:1","State":"running","Status":"Up 3 days"}
			]`)
		case strings.HasSuffix(path, "/stats"):
			fmt.Fprint(w, `{"memory_stats":{"usage":1048576}}`)
		case strings.HasSuffix(path, "/json"):
			inspects.Add(1)
			pid := map[string]int{"aaaaaaaaaaaa": 4001, "bbbbbbbbbbbb": 4002, "cccccccccccc": 4003}[strings.Split(path, "/")[2]]
			fmt.Fprintf(w, `{"State":{"Pid":%d},"Config":{"Env":["SECRET=1"]}}`, pid)
		default:
			t.Errorf("unexpected path: %s", path)
		}
	}))
	defer server.Close()

	dm := newDockerManagerForVersionTest(server)
	dm.dockerVersionChecked = true
	dm.imageUpdatesDisabled = true
	dm.excludeContainers = []string{"hidden*"}

	pids := func() map[string]uint32 {
		stats, err := dm.getDockerStats(defaultCacheTimeMs)
		require.NoError(t, err)
		out := map[string]uint32{}
		for _, s := range stats {
			out[s.Name] = s.Pid
		}
		return out
	}

	pids() // the first poll starts the look-up in the background and does not wait for it
	dm.pidCache.wait()
	assert.Equal(t, map[string]uint32{"web": 4001, "db": 4002}, pids())
	for range 3 {
		pids()
	}
	dm.pidCache.wait()
	assert.Equal(t, int64(2), inspects.Load(), "two containers inspected once, the excluded one never")
	assert.Len(t, dm.pidCache.entries, 2)
}
