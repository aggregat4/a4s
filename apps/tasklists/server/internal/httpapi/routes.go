package httpapi

import (
	"encoding/json"
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
	mux.HandleFunc("/healthz", handleHealthz)
}

func (s *Server) handleBootstrap(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	ops, serverSeq, err := s.store.GetOpsSince(r.Context(), 0)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, jsonResponse{"serverSeq": serverSeq, "ops": ops})
}

func (s *Server) handlePush(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var payload struct {
		ClientID string       `json:"clientId"`
		Ops      []storage.Op `json:"ops"`
	}
	if err := decodeJSON(r, &payload); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if payload.ClientID == "" {
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "clientId is required"})
		return
	}
	serverSeq, err := s.store.InsertOps(r.Context(), payload.Ops)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if err := s.store.TouchClient(r.Context(), payload.ClientID); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, jsonResponse{"serverSeq": serverSeq})
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
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if err := s.store.UpdateClientCursor(r.Context(), clientID, serverSeq); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, jsonResponse{"serverSeq": serverSeq, "ops": ops})
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
