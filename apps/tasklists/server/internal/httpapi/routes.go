package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strconv"
	"time"

	"prototype-lists/server/internal/storage"
)

type jsonResponse map[string]any

type errorResponse struct {
	Error string `json:"error"`
}

type Server struct {
	store storage.Store
}

func NewServer(store storage.Store) *Server {
	return &Server{store: store}
}

func (s *Server) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/sync/bootstrap", s.handleBootstrap)
	mux.HandleFunc("/sync/push", s.handlePush)
	mux.HandleFunc("/sync/pull", s.handlePull)
	mux.HandleFunc("/sync/reset", s.handleReset)
	mux.HandleFunc("/healthz", handleHealthz)
}

func (s *Server) handleBootstrap(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	snapshot, err := s.store.GetSnapshot(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	ops, serverSeq, err := s.store.GetOpsSince(r.Context(), 0)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, jsonResponse{
		"datasetGenerationKey": snapshot.DatasetGenerationKey,
		"snapshot":             snapshot.Blob,
		"serverSeq":            serverSeq,
		"ops":                  ops,
	})
}

func (s *Server) handlePush(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var payload struct {
		ClientID             string       `json:"clientId"`
		DatasetGenerationKey string       `json:"datasetGenerationKey"`
		Ops                  []storage.Op `json:"ops"`
	}
	if err := decodeJSON(r, &payload); err != nil {
		log.Printf("sync push decode error: %v", err)
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if payload.ClientID == "" {
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "clientId is required"})
		return
	}
	if payload.DatasetGenerationKey == "" {
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "datasetGenerationKey is required"})
		return
	}
	datasetGenerationKey, ok := s.ensureDatasetMatch(r.Context(), payload.DatasetGenerationKey, w)
	if !ok {
		return
	}
	serverSeq, err := s.store.InsertOps(r.Context(), payload.Ops)
	if err != nil {
		log.Printf("sync push insert error client=%s ops=%d: %v", payload.ClientID, len(payload.Ops), err)
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if err := s.store.TouchClient(r.Context(), payload.ClientID); err != nil {
		log.Printf("sync push touch error client=%s: %v", payload.ClientID, err)
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, jsonResponse{
		"serverSeq":            serverSeq,
		"datasetGenerationKey": datasetGenerationKey,
	})
}

func (s *Server) handlePull(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	clientID := r.URL.Query().Get("clientId")
	if clientID == "" {
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "clientId is required"})
		return
	}
	datasetGenerationKey := r.URL.Query().Get("datasetGenerationKey")
	if datasetGenerationKey == "" {
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "datasetGenerationKey is required"})
		return
	}
	currentDatasetGenerationKey, ok := s.ensureDatasetMatch(r.Context(), datasetGenerationKey, w)
	if !ok {
		return
	}
	sinceValue := r.URL.Query().Get("since")
	since := int64(0)
	if sinceValue != "" {
		parsed, err := strconv.ParseInt(sinceValue, 10, 64)
		if err != nil || parsed < 0 {
			writeJSON(w, http.StatusBadRequest, errorResponse{Error: "since must be a non-negative integer"})
			return
		}
		since = parsed
	}
	ops, serverSeq, err := s.store.GetOpsSince(r.Context(), since)
	if err != nil {
		log.Printf("sync pull error client=%s since=%d: %v", clientID, since, err)
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if err := s.store.UpdateClientCursor(r.Context(), clientID, serverSeq); err != nil {
		log.Printf("sync pull cursor error client=%s seq=%d: %v", clientID, serverSeq, err)
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, jsonResponse{
		"serverSeq":            serverSeq,
		"datasetGenerationKey": currentDatasetGenerationKey,
		"ops":                  ops,
	})
}

func (s *Server) handleReset(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var payload struct {
		ClientID             string `json:"clientId"`
		DatasetGenerationKey string `json:"datasetGenerationKey"`
		Snapshot             string `json:"snapshot"`
	}
	if err := decodeJSON(r, &payload); err != nil {
		log.Printf("sync reset decode error: %v", err)
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if payload.ClientID == "" {
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "clientId is required"})
		return
	}
	if payload.DatasetGenerationKey == "" {
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "datasetGenerationKey is required"})
		return
	}
	if err := s.store.ReplaceSnapshot(r.Context(), storage.Snapshot{
		DatasetGenerationKey: payload.DatasetGenerationKey,
		Blob:                 payload.Snapshot,
	}); err != nil {
		if errors.Is(err, storage.ErrDatasetGenerationKeyExists) {
			writeJSON(w, http.StatusConflict, errorResponse{Error: err.Error()})
			return
		}
		log.Printf("sync reset error client=%s: %v", payload.ClientID, err)
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, jsonResponse{
		"serverSeq":            int64(0),
		"datasetGenerationKey": payload.DatasetGenerationKey,
	})
}

func handleHealthz(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	writeJSON(w, http.StatusOK, jsonResponse{
		"status": "ok",
		"time":   time.Now().UTC().Format(time.RFC3339),
	})
}

func (s *Server) ensureDatasetMatch(ctx context.Context, clientDatasetGenerationKey string, w http.ResponseWriter) (string, bool) {
	datasetGenerationKey, err := s.store.GetActiveDatasetGenerationKey(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return "", false
	}
	if clientDatasetGenerationKey == datasetGenerationKey {
		return datasetGenerationKey, true
	}
	snapshot, err := s.store.GetSnapshot(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return "", false
	}
	writeJSON(w, http.StatusConflict, jsonResponse{
		"datasetGenerationKey": snapshot.DatasetGenerationKey,
		"snapshot":             snapshot.Blob,
	})
	return datasetGenerationKey, false
}

func methodNotAllowed(w http.ResponseWriter) {
	writeJSON(w, http.StatusMethodNotAllowed, errorResponse{Error: "method not allowed"})
}

func writeError(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, errorResponse{Error: err.Error()})
}

func decodeJSON(r *http.Request, target any) error {
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	return decoder.Decode(target)
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if payload == nil {
		return
	}
	encoder := json.NewEncoder(w)
	encoder.SetIndent("", "  ")
	_ = encoder.Encode(payload)
}
