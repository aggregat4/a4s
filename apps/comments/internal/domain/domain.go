package domain

type Config struct {
	Port                      int    `fig:"port" validate:"required"`
	DatabaseFilename          string `fig:"database_filename" validate:"required"`
	ServerReadTimeoutSeconds  int    `fig:"server_read_timeout_seconds" validate:"required"`
	ServerWriteTimeoutSeconds int    `fig:"server_write_timeout_seconds" validate:"required"`
	OidcIdpServer             string
	OidcClientId              string
	OidcClientSecret          string
	OidcRedirectUri           string
}
