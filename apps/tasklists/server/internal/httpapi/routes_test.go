package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"testing"

	"a4-tasklists/server/internal/auth"
	"a4-tasklists/server/internal/storage"
)

type bootstrapResponse struct {
	DatasetGenerationKey string `json:"datasetGenerationKey"`
	Snapshot             string `json:"snapshot"`
	ServerSeq            int64  `json:"serverSeq"`
}

type pushCursorStore struct {
	lastCursorClientID string
	lastCursorUserID   string
	lastCursorSeq      int64
}

func (s *pushCursorStore) Init(context.Context) error { return nil }
func (s *pushCursorStore) Close() error               { return nil }
func (s *pushCursorStore) InsertOps(context.Context, string, []storage.Op) (int64, error) {
	return 42, nil
}
func (s *pushCursorStore) GetOpsSince(context.Context, string, int64) ([]storage.Op, int64, error) {
	return nil, 0, nil
}
func (s *pushCursorStore) GetActiveDatasetGenerationKey(context.Context, string) (string, error) {
	return "dataset-1", nil
}
func (s *pushCursorStore) GetSnapshot(context.Context, string) (storage.Snapshot, error) {
	return storage.Snapshot{DatasetGenerationKey: "dataset-1", Blob: "{}"}, nil
}
func (s *pushCursorStore) ReplaceSnapshot(context.Context, string, storage.Snapshot) error { return nil }
func (s *pushCursorStore) TouchClient(context.Context, string, string) error               { return nil }
func (s *pushCursorStore) UpdateClientCursor(_ context.Context, userID string, clientID string, serverSeq int64) error {
	s.lastCursorUserID = userID
	s.lastCursorClientID = clientID
	s.lastCursorSeq = serverSeq
	return nil
}

func newTestMux(t *testing.T) *http.ServeMux {
	t.Helper()
	store := newTestStore(t)
	server := NewServer(store)
	mux := http.NewServeMux()
	server.RegisterRoutes(mux)
	return mux
}

func newTestStore(t *testing.T) storage.Store {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "test.db")
	store, err := storage.OpenSQLite(path)
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	if err := store.Init(t.Context()); err != nil {
		t.Fatalf("init sqlite: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store
}

func TestBootstrapEmpty(t *testing.T) {
	mux := newTestMux(t)

	resp := doRequest(t, mux, http.MethodGet, "/sync/bootstrap", nil)
	if resp.Code != http.StatusOK {
		t.Fatalf("status: got %d", resp.Code)
	}
	var payload struct {
		DatasetGenerationKey string `json:"datasetGenerationKey"`
		Snapshot             string `json:"snapshot"`
		ServerSeq            int64  `json:"serverSeq"`
		Ops                  []any  `json:"ops"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if payload.DatasetGenerationKey == "" {
		t.Fatalf("datasetGenerationKey should be set")
	}
	if payload.ServerSeq != 0 {
		t.Fatalf("serverSeq: got %d", payload.ServerSeq)
	}
	if len(payload.Ops) != 0 {
		t.Fatalf("ops length: got %d", len(payload.Ops))
	}
}

func TestPushPullRoundTrip(t *testing.T) {
	mux := newTestMux(t)

	bootstrap := fetchBootstrap(t, mux)
	body := map[string]any{
		"clientId":             "client-1",
		"datasetGenerationKey": bootstrap.DatasetGenerationKey,
		"ops": []map[string]any{
			{
				"scope":      "list",
				"resourceId": "list-1",
				"actor":      "actor-1",
				"clock":      1,
				"payload":    map[string]any{"type": "insert", "itemId": "item-1"},
			},
		},
	}
	requestBody, _ := json.Marshal(body)
	resp := doRequest(t, mux, http.MethodPost, "/sync/push", requestBody)
	if resp.Code != http.StatusOK {
		t.Fatalf("push status: got %d", resp.Code)
	}

	pullResp := doRequest(t, mux, http.MethodGet, "/sync/pull?since=0&clientId=client-1&datasetGenerationKey="+bootstrap.DatasetGenerationKey, nil)
	if pullResp.Code != http.StatusOK {
		t.Fatalf("pull status: got %d", pullResp.Code)
	}
	var pullPayload struct {
		DatasetGenerationKey string       `json:"datasetGenerationKey"`
		ServerSeq            int64        `json:"serverSeq"`
		Ops                  []storage.Op `json:"ops"`
	}
	if err := json.NewDecoder(pullResp.Body).Decode(&pullPayload); err != nil {
		t.Fatalf("decode pull: %v", err)
	}
	if pullPayload.DatasetGenerationKey != bootstrap.DatasetGenerationKey {
		t.Fatalf("datasetGenerationKey mismatch: %s", pullPayload.DatasetGenerationKey)
	}
	if pullPayload.ServerSeq == 0 {
		t.Fatalf("serverSeq not updated")
	}
	if len(pullPayload.Ops) != 1 {
		t.Fatalf("ops length: got %d", len(pullPayload.Ops))
	}
	if pullPayload.Ops[0].Scope != "list" || pullPayload.Ops[0].Resource != "list-1" {
		t.Fatalf("unexpected op metadata: %+v", pullPayload.Ops[0])
	}
}

func TestPushDedupe(t *testing.T) {
	mux := newTestMux(t)

	bootstrap := fetchBootstrap(t, mux)
	body := map[string]any{
		"clientId":             "client-1",
		"datasetGenerationKey": bootstrap.DatasetGenerationKey,
		"ops": []map[string]any{
			{
				"scope":      "list",
				"resourceId": "list-1",
				"actor":      "actor-1",
				"clock":      1,
				"payload":    map[string]any{"type": "insert", "itemId": "item-1"},
			},
		},
	}
	requestBody, _ := json.Marshal(body)
	doRequest(t, mux, http.MethodPost, "/sync/push", requestBody)
	doRequest(t, mux, http.MethodPost, "/sync/push", requestBody)

	pullResp := doRequest(t, mux, http.MethodGet, "/sync/pull?since=0&clientId=client-1&datasetGenerationKey="+bootstrap.DatasetGenerationKey, nil)
	var pullPayload struct {
		Ops []storage.Op `json:"ops"`
	}
	if err := json.NewDecoder(pullResp.Body).Decode(&pullPayload); err != nil {
		t.Fatalf("decode pull: %v", err)
	}
	if len(pullPayload.Ops) != 1 {
		t.Fatalf("ops length: got %d", len(pullPayload.Ops))
	}
}

func TestPullMissingClientID(t *testing.T) {
	mux := newTestMux(t)

	resp := doRequest(t, mux, http.MethodGet, "/sync/pull?since=0&datasetGenerationKey=missing", nil)
	if resp.Code != http.StatusBadRequest {
		t.Fatalf("status: got %d", resp.Code)
	}
}

func TestPushMissingClientID(t *testing.T) {
	mux := newTestMux(t)

	body := map[string]any{
		"datasetGenerationKey": "dataset-x",
		"ops": []map[string]any{
			{
				"scope":      "list",
				"resourceId": "list-1",
				"actor":      "actor-1",
				"clock":      1,
				"payload":    map[string]any{"type": "insert", "itemId": "item-1"},
			},
		},
	}
	requestBody, _ := json.Marshal(body)
	resp := doRequest(t, mux, http.MethodPost, "/sync/push", requestBody)
	if resp.Code != http.StatusBadRequest {
		t.Fatalf("status: got %d", resp.Code)
	}
}

func TestResetSnapshot(t *testing.T) {
	mux := newTestMux(t)

	bootstrap := fetchBootstrap(t, mux)
	resetPayload := map[string]any{
		"clientId":             "client-1",
		"datasetGenerationKey": "dataset-new",
		"snapshot":             `{"schema":"net.aggregat4.tasklist.snapshot@v1","data":{"registry":{"clock":0,"entries":[]},"lists":[]}}`,
	}
	body, _ := json.Marshal(resetPayload)
	resp := doRequest(t, mux, http.MethodPost, "/sync/reset", body)
	if resp.Code != http.StatusOK {
		t.Fatalf("reset status: got %d", resp.Code)
	}

	after := fetchBootstrap(t, mux)
	if after.DatasetGenerationKey == bootstrap.DatasetGenerationKey {
		t.Fatalf("datasetGenerationKey should change after reset")
	}
	if after.DatasetGenerationKey != "dataset-new" {
		t.Fatalf("unexpected datasetGenerationKey: %s", after.DatasetGenerationKey)
	}
}

func TestResetRejectsDuplicateDatasetGenerationKey(t *testing.T) {
	mux := newTestMux(t)
	bootstrap := fetchBootstrap(t, mux)

	resetPayload := map[string]any{
		"clientId":             "client-1",
		"datasetGenerationKey": bootstrap.DatasetGenerationKey,
		"snapshot":             `{"schema":"net.aggregat4.tasklist.snapshot@v1","data":{"registry":{"clock":0,"entries":[]},"lists":[]}}`,
	}
	body, _ := json.Marshal(resetPayload)
	resp := doRequest(t, mux, http.MethodPost, "/sync/reset", body)
	if resp.Code != http.StatusConflict {
		t.Fatalf("reset status: got %d", resp.Code)
	}
}

func TestPullDatasetMismatch(t *testing.T) {
	mux := newTestMux(t)

	resp := doRequest(t, mux, http.MethodGet, "/sync/pull?since=0&clientId=client-1&datasetGenerationKey=wrong", nil)
	if resp.Code != http.StatusConflict {
		t.Fatalf("status: got %d", resp.Code)
	}
	var payload struct {
		DatasetGenerationKey string `json:"datasetGenerationKey"`
		Snapshot             string `json:"snapshot"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if payload.DatasetGenerationKey == "" {
		t.Fatalf("datasetGenerationKey should be returned")
	}
}

func fetchBootstrap(t *testing.T, mux *http.ServeMux) bootstrapResponse {
	t.Helper()
	resp := doRequest(t, mux, http.MethodGet, "/sync/bootstrap", nil)
	if resp.Code != http.StatusOK {
		t.Fatalf("bootstrap status: got %d", resp.Code)
	}
	var payload bootstrapResponse
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		t.Fatalf("decode bootstrap: %v", err)
	}
	if payload.DatasetGenerationKey == "" {
		t.Fatalf("datasetGenerationKey missing")
	}
	return payload
}

func doRequest(t *testing.T, mux *http.ServeMux, method, path string, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, bytes.NewReader(body))
	req = req.WithContext(auth.ContextWithUserID(req.Context(), "user-1"))
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, req)
	return recorder
}

func TestHealthz(t *testing.T) {
	mux := newTestMux(t)
	resp := doRequest(t, mux, http.MethodGet, "/healthz", nil)
	if resp.Code != http.StatusOK {
		t.Fatalf("status: got %d", resp.Code)
	}
}

func TestTwoClientsSync(t *testing.T) {
	mux := newTestMux(t)
	bootstrap := fetchBootstrap(t, mux)
	payload := map[string]any{
		"clientId":             "client-a",
		"datasetGenerationKey": bootstrap.DatasetGenerationKey,
		"ops": []map[string]any{
			{
				"scope":      "registry",
				"resourceId": "registry",
				"actor":      "actor-a",
				"clock":      1,
				"payload": map[string]any{
					"type":   "createList",
					"listId": "list-1",
					"title":  "Inbox",
				},
			},
		},
	}
	body, _ := json.Marshal(payload)
	doRequest(t, mux, http.MethodPost, "/sync/push", body)
	pullResp := doRequest(t, mux, http.MethodGet, "/sync/pull?since=0&clientId=client-b&datasetGenerationKey="+bootstrap.DatasetGenerationKey, nil)
	var pullPayload struct {
		ServerSeq int64        `json:"serverSeq"`
		Ops       []storage.Op `json:"ops"`
	}
	if err := json.NewDecoder(pullResp.Body).Decode(&pullPayload); err != nil {
		t.Fatalf("decode pull: %v", err)
	}
	if pullPayload.ServerSeq == 0 {
		t.Fatalf("serverSeq not updated")
	}
	if len(pullPayload.Ops) != 1 {
		t.Fatalf("ops length: got %d", len(pullPayload.Ops))
	}

	pullResp2 := doRequest(t, mux, http.MethodGet, "/sync/pull?since="+strconv.FormatInt(pullPayload.ServerSeq, 10)+"&clientId=client-b&datasetGenerationKey="+bootstrap.DatasetGenerationKey, nil)
	var pullPayload2 struct {
		Ops []storage.Op `json:"ops"`
	}
	if err := json.NewDecoder(pullResp2.Body).Decode(&pullPayload2); err != nil {
		t.Fatalf("decode pull: %v", err)
	}
	if len(pullPayload2.Ops) != 0 {
		t.Fatalf("ops length: got %d", len(pullPayload2.Ops))
	}
}

func TestPushUpdatesClientCursor(t *testing.T) {
	store := &pushCursorStore{}
	server := NewServer(store)
	mux := http.NewServeMux()
	server.RegisterRoutes(mux)

	body := map[string]any{
		"clientId":             "client-1",
		"datasetGenerationKey": "dataset-1",
		"ops": []map[string]any{
			{
				"scope":      "list",
				"resourceId": "list-1",
				"actor":      "actor-1",
				"clock":      1,
				"payload":    map[string]any{"type": "insert", "itemId": "item-1"},
			},
		},
	}
	requestBody, _ := json.Marshal(body)
	resp := doRequest(t, mux, http.MethodPost, "/sync/push", requestBody)
	if resp.Code != http.StatusOK {
		t.Fatalf("push status: got %d", resp.Code)
	}
	if store.lastCursorUserID != "user-1" {
		t.Fatalf("cursor user id mismatch: %s", store.lastCursorUserID)
	}
	if store.lastCursorClientID != "client-1" {
		t.Fatalf("cursor client id mismatch: %s", store.lastCursorClientID)
	}
	if store.lastCursorSeq != 42 {
		t.Fatalf("cursor seq mismatch: got %d", store.lastCursorSeq)
	}
}
