package httpapi

import (
	"encoding/json"
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
		"datasetId": snapshot.DatasetID,
		"snapshot":  snapshot.Blob,
		"serverSeq": serverSeq,
		"ops":       ops,
	})
}

func (s *Server) handlePush(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var payload struct {
		ClientID  string       `json:"clientId"`
		DatasetID string       `json:"datasetId"`
		Ops       []storage.Op `json:"ops"`
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
	if payload.DatasetID == "" {
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "datasetId is required"})
		return
	}
	snapshot, err := s.store.GetSnapshot(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if payload.DatasetID != snapshot.DatasetID {
		writeJSON(w, http.StatusConflict, jsonResponse{
			"datasetId": snapshot.DatasetID,
			"snapshot":  snapshot.Blob,
		})
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
		"serverSeq": serverSeq,
		"datasetId": snapshot.DatasetID,
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
	datasetID := r.URL.Query().Get("datasetId")
	if datasetID == "" {
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "datasetId is required"})
		return
	}
	snapshot, err := s.store.GetSnapshot(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if datasetID != snapshot.DatasetID {
		writeJSON(w, http.StatusConflict, jsonResponse{
			"datasetId": snapshot.DatasetID,
			"snapshot":  snapshot.Blob,
		})
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
		"serverSeq": serverSeq,
		"datasetId": snapshot.DatasetID,
		"ops":       ops,
	})
}

func (s *Server) handleReset(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var payload struct {
		ClientID  string `json:"clientId"`
		DatasetID string `json:"datasetId"`
		Snapshot  string `json:"snapshot"`
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
	if payload.DatasetID == "" {
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "datasetId is required"})
		return
	}
	if err := s.store.ReplaceSnapshot(r.Context(), storage.Snapshot{
		DatasetID: payload.DatasetID,
		Blob:      payload.Snapshot,
	}); err != nil {
		log.Printf("sync reset error client=%s: %v", payload.ClientID, err)
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, jsonResponse{
		"serverSeq": int64(0),
		"datasetId": payload.DatasetID,
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
