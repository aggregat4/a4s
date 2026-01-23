package httpapi

import (
	"encoding/json"
	"net/http"
	"time"
)

type jsonResponse map[string]any

type errorResponse struct {
	Error string `json:"error"`
}

func RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/sync/bootstrap", handleBootstrap)
	mux.HandleFunc("/sync/push", handlePush)
	mux.HandleFunc("/sync/pull", handlePull)
	mux.HandleFunc("/healthz", handleHealthz)
}

func handleBootstrap(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	writeJSON(w, http.StatusOK, jsonResponse{"serverSeq": 0, "ops": []any{}})
}

func handlePush(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	writeJSON(w, http.StatusOK, jsonResponse{"serverSeq": 0})
}

func handlePull(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	writeJSON(w, http.StatusOK, jsonResponse{"serverSeq": 0, "ops": []any{}})
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
