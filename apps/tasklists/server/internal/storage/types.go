package storage

import "encoding/json"

// Op is the generic sync envelope stored by the server.
type Op struct {
	ServerSeq int64           `json:"serverSeq,omitempty"`
	Scope     string          `json:"scope"`
	Resource  string          `json:"resourceId"`
	Actor     string          `json:"actor"`
	Clock     int64           `json:"clock"`
	Payload   json.RawMessage `json:"payload"`
}
