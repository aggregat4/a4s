# Debian deployment

This directory is the canonical operational configuration for the A4 services.
Application directories describe each binary's runtime contract; this directory
describes the intended steady-state deployment on a Debian host.

The files are templates, not a copy of a live host. Never commit production
credentials, private keys, databases, generated certificates, or mutable state.

## Filesystem layout

Each service uses an independently versioned release directory, an atomic
`current` symlink, and a persistent state directory:

```text
/opt/a4services/<service>/
├── <version>/
├── current -> <version>
└── data-or-db-directory/
```

Release directories and the `current` link are owned by `root:root` and are not
writable by the service process. Each process has a dedicated system user and
can write only its state directory:

| Service | System user | State directory | Local port |
| --- | --- | --- | --- |
| Bookmarks | `a4-bookmarks` | `/opt/a4services/bookmarks/db` | 1302 |
| OpenID Provider | `a4-openidprovider` | `/opt/a4services/openidprovider/data` | 1301 |
| RSSGrid | `a4-rssgrid` | `/opt/a4services/rssgrid/data` | 1400 |
| Tasklists | `a4-tasklists` | `/opt/a4services/tasklists/data` | 9085 |
| Comments | `a4-comments` | `/opt/a4services/comments/data` | 1333 |

The canonical Tasklists directory, unit, executable, and release archive prefix
are named `tasklists`. Its system account remains `a4-tasklists`.

## Service accounts

Create one Debian system account per service. `--system` allocates a system
UID, `--user-group` creates a matching private group, `--no-create-home` avoids
creating an unused home, and `/usr/sbin/nologin` prevents interactive login.
Systemd can still start a process as these users.

Run each command once for an account that does not already exist:

```bash
sudo useradd --system --user-group --no-create-home \
  --home-dir /nonexistent --shell /usr/sbin/nologin a4-bookmarks
sudo useradd --system --user-group --no-create-home \
  --home-dir /nonexistent --shell /usr/sbin/nologin a4-openidprovider
sudo useradd --system --user-group --no-create-home \
  --home-dir /nonexistent --shell /usr/sbin/nologin a4-rssgrid
sudo useradd --system --user-group --no-create-home \
  --home-dir /nonexistent --shell /usr/sbin/nologin a4-tasklists
sudo useradd --system --user-group --no-create-home \
  --home-dir /nonexistent --shell /usr/sbin/nologin a4-comments
```

Verify the records and their non-login shells with:

```bash
getent passwd a4-bookmarks a4-openidprovider a4-rssgrid a4-tasklists a4-comments
```

Create the service roots as `root:root` and only the persistent state
directories as service-owned:

```bash
sudo install -d -o root -g root -m 0755 /opt/a4services
sudo install -d -o root -g root -m 0755 /opt/a4services/bookmarks
sudo install -d -o root -g root -m 0755 /opt/a4services/openidprovider
sudo install -d -o root -g root -m 0755 /opt/a4services/rssgrid
sudo install -d -o root -g root -m 0755 /opt/a4services/tasklists
sudo install -d -o root -g root -m 0755 /opt/a4services/comments

sudo install -d -o a4-bookmarks -g a4-bookmarks -m 0750 \
  /opt/a4services/bookmarks/db
sudo install -d -o a4-openidprovider -g a4-openidprovider -m 0750 \
  /opt/a4services/openidprovider/data
sudo install -d -o a4-rssgrid -g a4-rssgrid -m 0750 \
  /opt/a4services/rssgrid/data
sudo install -d -o a4-tasklists -g a4-tasklists -m 0750 \
  /opt/a4services/tasklists/data
sudo install -d -o a4-comments -g a4-comments -m 0750 \
  /opt/a4services/comments/data
```

The systemd hardening makes the rest of the filesystem read-only to each
service. If a future feature needs another writable path, add that path
explicitly instead of weakening the entire unit.

## Configuration and secrets

Runtime configuration lives under `/etc/a4s`, outside release directories:

| Source template | Live path | Ownership/mode |
| --- | --- | --- |
| `env/bookmarks.env.example` | `/etc/a4s/bookmarks.env` | `root:a4-bookmarks`, `0640` |
| `env/rssgrid.env.example` | `/etc/a4s/rssgrid.env` | `root:a4-rssgrid`, `0640` |
| `env/tasklists.env.example` | `/etc/a4s/tasklists.env` | `root:a4-tasklists`, `0640` |
| `config/comments/commentservice.json` | `/etc/a4s/comments/commentservice.json` | `root:a4-comments`, `0640` |
| `env/comments.env.example` | `/etc/a4s/comments.env` | `root:a4-comments`, `0640` |
| `config/rssgrid/rssgrid.json` | `/etc/a4s/rssgrid/rssgrid.json` | `root:a4-rssgrid`, `0644` |
| `config/openidprovider/openidprovider.json.example` | `/etc/a4s/openidprovider/openidprovider.json` | `root:a4-openidprovider`, `0640` |
| OpenID Provider private key | `/etc/a4s/openidprovider/private.pem` | `root:a4-openidprovider`, `0640` |
| OpenID Provider public key | `/etc/a4s/openidprovider/public.pem` | `root:a4-openidprovider`, `0644` |

Provision the configuration directories before installing files:

```bash
sudo install -d -o root -g root -m 0755 /etc/a4s
sudo install -d -o root -g a4-comments -m 0750 /etc/a4s/comments
sudo install -d -o root -g a4-openidprovider -m 0750 /etc/a4s/openidprovider
sudo install -d -o root -g a4-rssgrid -m 0750 /etc/a4s/rssgrid
```

Generate independent secrets rather than reusing one value:

```bash
openssl rand -base64 32
openssl rand -hex 32
```

The hexadecimal form is required for `COMMENTSERVICE_ENCRYPTION_KEY`. Review
every `replace-with-...` value before installation. The OpenID Provider loads
secrets directly from its JSON configuration, so that file must remain
non-world-readable. Its signing key must remain stable across deployments;
unexpected key replacement changes the provider's signing identity.

## systemd

Install the units in `/etc/systemd/system`, verify all five, and reload the
manager configuration:

```bash
sudo install -m 0644 deploy/systemd/*.service /etc/systemd/system/
sudo systemd-analyze verify /etc/systemd/system/bookmarks.service \
  /etc/systemd/system/comments.service \
  /etc/systemd/system/openidprovider.service \
  /etc/systemd/system/rssgrid.service \
  /etc/systemd/system/tasklists.service
sudo systemctl daemon-reload
```

Enable and start a service by its canonical unit name:

```bash
sudo systemctl enable --now bookmarks.service
sudo systemctl status bookmarks.service
sudo journalctl -u bookmarks.service --since today
```

OpenID Provider exposes `/status`, Tasklists exposes `/healthz`, and Comments
exposes `/status`. Bookmarks and RSSGrid do not have unauthenticated health
endpoints, so use unit state, logs, and an authenticated smoke test for them.

## Nginx and certificates

Nginx is split into one site per service plus shared proxy, TLS, SSE, and
rate-limit snippets. `nginx/conf.d/a4-rate-limits.conf` belongs in
`/etc/nginx/conf.d`, where Debian includes it inside the `http` context.

All sites refer to a Let's Encrypt certificate named `a4services`. The
certificate covers every configured public service hostname:

```bash
sudo certbot certonly --nginx --cert-name a4services \
  -d openidprovider.aggregat4.net \
  -d bookmarks.aggregat4.net \
  -d rssgrid.aggregat4.net \
  -d tasklists.aggregat4.net \
  -d comments.aggregat4.net
```

DNS must point at the host before requesting a certificate for a name. Install
the shared files and sites, enable the desired site symlinks, and test before
reloading:

```bash
sudo install -m 0644 deploy/nginx/conf.d/a4-rate-limits.conf /etc/nginx/conf.d/
sudo install -m 0644 deploy/nginx/snippets/*.conf /etc/nginx/snippets/
sudo install -m 0644 deploy/nginx/sites/*.conf /etc/nginx/sites-available/
sudo ln -s /etc/nginx/sites-available/bookmarks.conf /etc/nginx/sites-enabled/bookmarks.conf
sudo ln -s /etc/nginx/sites-available/comments.conf /etc/nginx/sites-enabled/comments.conf
sudo ln -s /etc/nginx/sites-available/openidprovider.conf /etc/nginx/sites-enabled/openidprovider.conf
sudo ln -s /etc/nginx/sites-available/rssgrid.conf /etc/nginx/sites-enabled/rssgrid.conf
sudo ln -s /etc/nginx/sites-available/tasklists.conf /etc/nginx/sites-enabled/tasklists.conf
sudo nginx -t
sudo systemctl reload nginx
```

Only the managed A4 site symlinks should be enabled for these hostnames. The
Tasklists `/sync/events` location uses the SSE snippet; its one-hour proxy
timeout is safely longer than the server's 30-second heartbeat.

## Release and rollback

Build one application package from the repository root:

```bash
task package APP=rssgrid VERSION=v1.5.0
```

`APP` accepts `rssgrid`, `bookmarks`, `comments`, `idp`, or `tasklists`.
`VERSION` accepts either a plain semantic version or its matching namespaced
tag, such as `rssgrid/v1.5.0`. Linux and amd64 are the default target; override
the ignored output directory with `OUTPUT_DIR=...` when needed.

| App | Archive prefix | Root-level binaries |
| --- | --- | --- |
| `rssgrid` | `rssgrid` | `rssgrid` |
| `bookmarks` | `bookmarks` | `bmimporter`, `bmserver` |
| `comments` | `comments` | `gocomments-createencryptionkey`, `gocomments-createservice`, `gocomments-server` |
| `idp` | `openidprovider` | `createkey`, `createuser`, `server` |
| `tasklists` | `tasklists` | `tasklists` |

Archive prefixes match the canonical deployed service-directory names. Binary
names remain part of each application's runtime interface and can differ from
the archive prefix when an application ships multiple commands.

The CGO/SQLite applications are compiled inside the Go-version-matched Debian
Bookworm image. Tasklists is a static binary with its frontend embedded. Every
archive has an adjacent `.sha256` file and contains binaries directly at its
root, matching the version-directory layout used by systemd.

Never unpack over `current`. Put each release in a new immutable version
directory, verify its checksum and ownership, then switch the relative symlink
atomically on the same filesystem. For example:

```bash
cd /opt/a4services/rssgrid
sudo ln -sfn 1.5.0 current.next
sudo mv -Tf current.next current
sudo systemctl restart rssgrid.service
```

Keep at least the previous version directory. If the unit or smoke test fails,
point `current.next` at the previous version, atomically replace `current`
again, and restart. A binary rollback does not roll back a database migration;
take an SQLite-consistent backup and check release notes before deploying a
schema-changing version.
