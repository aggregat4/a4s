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

type Snapshot struct {
	DatasetGenerationID  int64  `json:"-"`
	DatasetGenerationKey string `json:"datasetGenerationKey"`
	Blob                 string `json:"snapshot"`
}
