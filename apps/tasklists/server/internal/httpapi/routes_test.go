package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"testing"

	"prototype-lists/server/internal/storage"
)

func newTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	store := newTestStore(t)
	server := NewServer(store)
	mux := http.NewServeMux()
	server.RegisterRoutes(mux)
	return httptest.NewServer(mux)
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
	server := newTestServer(t)
	defer server.Close()

	resp, err := http.Get(server.URL + "/sync/bootstrap")
	if err != nil {
		t.Fatalf("bootstrap request: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status: got %d", resp.StatusCode)
	}
	var payload struct {
		ServerSeq int64 `json:"serverSeq"`
		Ops       []any `json:"ops"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if payload.ServerSeq != 0 {
		t.Fatalf("serverSeq: got %d", payload.ServerSeq)
	}
	if len(payload.Ops) != 0 {
		t.Fatalf("ops length: got %d", len(payload.Ops))
	}
}

func TestPushPullRoundTrip(t *testing.T) {
	server := newTestServer(t)
	defer server.Close()

	body := map[string]any{
		"clientId": "client-1",
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
	resp, err := http.Post(server.URL+"/sync/push", "application/json", bytes.NewReader(requestBody))
	if err != nil {
		t.Fatalf("push request: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("push status: got %d", resp.StatusCode)
	}

	pullResp, err := http.Get(server.URL + "/sync/pull?since=0&clientId=client-1")
	if err != nil {
		t.Fatalf("pull request: %v", err)
	}
	defer pullResp.Body.Close()
	if pullResp.StatusCode != http.StatusOK {
		t.Fatalf("pull status: got %d", pullResp.StatusCode)
	}
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
	if pullPayload.Ops[0].Scope != "list" || pullPayload.Ops[0].Resource != "list-1" {
		t.Fatalf("unexpected op metadata: %+v", pullPayload.Ops[0])
	}
}

func TestPushDedupe(t *testing.T) {
	server := newTestServer(t)
	defer server.Close()

	body := map[string]any{
		"clientId": "client-1",
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
	_, err := http.Post(server.URL+"/sync/push", "application/json", bytes.NewReader(requestBody))
	if err != nil {
		t.Fatalf("push request: %v", err)
	}
	_, err = http.Post(server.URL+"/sync/push", "application/json", bytes.NewReader(requestBody))
	if err != nil {
		t.Fatalf("push request: %v", err)
	}

	pullResp, err := http.Get(server.URL + "/sync/pull?since=0&clientId=client-1")
	if err != nil {
		t.Fatalf("pull request: %v", err)
	}
	defer pullResp.Body.Close()
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
	server := newTestServer(t)
	defer server.Close()

	resp, err := http.Get(server.URL + "/sync/pull?since=0")
	if err != nil {
		t.Fatalf("pull request: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status: got %d", resp.StatusCode)
	}
}

func TestPushMissingClientID(t *testing.T) {
	server := newTestServer(t)
	defer server.Close()

	body := map[string]any{
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
	resp, err := http.Post(server.URL+"/sync/push", "application/json", bytes.NewReader(requestBody))
	if err != nil {
		t.Fatalf("push request: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status: got %d", resp.StatusCode)
	}
}

func TestHealthz(t *testing.T) {
	server := newTestServer(t)
	defer server.Close()

	resp, err := http.Get(server.URL + "/healthz")
	if err != nil {
		t.Fatalf("healthz request: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status: got %d", resp.StatusCode)
	}
}

func TestTwoClientsSync(t *testing.T) {
	server := newTestServer(t)
	defer server.Close()

	payload := map[string]any{
		"clientId": "client-a",
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
	resp, err := http.Post(server.URL+"/sync/push", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("push request: %v", err)
	}
	resp.Body.Close()

	pullResp, err := http.Get(server.URL + "/sync/pull?since=0&clientId=client-b")
	if err != nil {
		t.Fatalf("pull request: %v", err)
	}
	defer pullResp.Body.Close()
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

	pullResp2, err := http.Get(server.URL + "/sync/pull?since=" + strconv.FormatInt(pullPayload.ServerSeq, 10) + "&clientId=client-b")
	if err != nil {
		t.Fatalf("pull request: %v", err)
	}
	defer pullResp2.Body.Close()
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
