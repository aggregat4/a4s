module aggregat4/go-commentservice

go 1.23

toolchain go1.23.1

require (
	github.com/aggregat4/go-baselib v1.4.0
	github.com/aggregat4/go-baselib-services/v3 v3.0.0
	github.com/google/uuid v1.6.0
	github.com/kirsle/configdir v0.0.0-20170128060238-e45d2f54772f
	github.com/kkyr/fig v0.4.0
	github.com/labstack/echo-contrib v0.17.1
	github.com/labstack/echo/v4 v4.12.0
	github.com/mattn/go-sqlite3 v1.14.23
	github.com/stretchr/testify v1.9.0
)

require (
	github.com/coreos/go-oidc/v3 v3.11.0
	github.com/davecgh/go-spew v1.1.1 // indirect
	github.com/go-jose/go-jose/v4 v4.0.4 // indirect
	github.com/golang-jwt/jwt v3.2.2+incompatible // indirect
	github.com/golang-jwt/jwt/v5 v5.2.1 // indirect
	github.com/gorilla/context v1.1.2 // indirect
	github.com/gorilla/securecookie v1.1.2 // indirect
	github.com/gorilla/sessions v1.4.0
	github.com/labstack/gommon v0.4.2 // indirect
	github.com/mattn/go-colorable v0.1.13 // indirect
	github.com/mattn/go-isatty v0.0.20 // indirect
	github.com/mitchellh/mapstructure v1.5.0 // indirect
	github.com/pelletier/go-toml/v2 v2.2.3 // indirect
	github.com/pmezard/go-difflib v1.0.0 // indirect
	github.com/valyala/bytebufferpool v1.0.0 // indirect
	github.com/valyala/fasttemplate v1.2.2 // indirect
	golang.org/x/crypto v0.27.0 // indirect
	golang.org/x/net v0.29.0 // indirect
	golang.org/x/oauth2 v0.23.0 // indirect
	golang.org/x/sys v0.25.0 // indirect
	golang.org/x/text v0.18.0 // indirect
	golang.org/x/time v0.6.0 // indirect
	gopkg.in/yaml.v3 v3.0.1 // indirect
)

// we use a local version of baseliboidc until the changes are merged and a new release is made
replace github.com/aggregat4/go-baselib-services/v3 => ../go-baselib-services
