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

Bookmarks is the one exception: `bmserver` also calls `godotenv.Load()` for a
`.env` file in its working directory, so `/opt/a4services/bookmarks/.env` is
read when present. It is optional (a missing file is not an error), and
variables already supplied by `EnvironmentFile` win, because godotenv does not
override the environment. It can still carry
`DELBM_OIDC_CLIENT_SECRET`, so keep it `root:a4-bookmarks` mode `0640` - never
world-readable - and treat it as a second source of truth for the same
settings. No other application reads a `.env`; the leftover
`/opt/a4services/tasklists/.env` was stale and has been retired.

Only the JSON configuration lives under `/etc/a4s`. The OpenID Provider keeps
its signing key pair and SQLite database in its state directory, and its
configuration points there:

```text
/opt/a4services/openidprovider/data/   0750 a4-openidprovider:a4-openidprovider
├── openidprovider.sqlite              0600   (databasefilename)
├── private.pem                        0600   (privatekeypemfilename)
└── public.pem                         0600   (publickeypemfilename)
```

`ProtectSystem=strict` plus `ReadWritePaths` makes that directory the only
writable path, so the key pair belongs with the mutable state rather than with
the read-only configuration.

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

## Deploying on the live host

The production host runs Debian 12 "bookworm" (glibc 2.36) and serves every
public service name. That libc version matches the Bookworm image used by
`task package`, so the CGO/SQLite archives run unchanged; re-check this baseline
before changing the host distribution or the packaging image. The machine's own
identity and access details belong in private operator notes, not here.

Do not deploy by hand. Use the deployer in this directory:

```bash
# with the archive and its .sha256 already in the archive directory
sudo deploy/scripts/deploy-service.sh <app> <version> --archive-dir <dir> [--dry-run]
# app: bookmarks | idp | rssgrid | tasklists, version: v1.9.2 or 1.9.2
```

| App | Unit | Archive prefix | Entry binary | State dir | Port | Health probe |
| --- | --- | --- | --- | --- | --- | --- |
| `bookmarks` | `bookmarks.service` | `bookmarks` | `bmserver` | `db` | 1302 | `/` → 302 |
| `idp` | `openidprovider.service` | `openidprovider` | `server` | `data` | 1301 | `/status` → 200 |
| `rssgrid` | `rssgrid.service` | `rssgrid` | `rssgrid` | `data` | 1400 | `/` → 302 |
| `tasklists` | `tasklists.service` | `tasklists` | `tasklists` | `data` | 9085 | `/healthz` → 200 |

The deployer enforces the rules in this file: it verifies the published
SHA-256 file, refuses to overwrite an existing version directory, copies the
database with the SQLite backup API and integrity-checks the copy, unpacks into
a new root-owned version directory, switches `current` with a relative symlink
and an atomic rename, restarts the unit, and waits for the health probe. If the
restart or the probe fails, it reverts `current`, restarts the previous release
and removes the new version directory. `--dry-run` prints the plan and changes
nothing.

The database backup waits on a SQLite busy timeout and retries up to three
times, so a transient exclusive lock from the running service (for example
during a checkpoint) does not abort a deployment; a real failure is reported
with the SQLite error text and leaves `current` untouched. Because these
backups, the migration backups under `/opt/a4services/cleanup-backup-*` and
`migration-backup-*`, and the OpenID Provider signing key are sensitive, their
directories stay `0700` and their files `0600`.

Host conventions:

| Path | Purpose |
| --- | --- |
| `/opt/a4services/<service>/<version>` | release directories, `root:root`, `0755` |
| `/opt/a4services/<service>/current` | relative symlink to the active version |
| `/opt/a4services/<service>/data` or `/db` | service-owned state, `0750`/`0600` |
| `/opt/a4services/backups` | SQLite backups made by the deployer, `root:root`, `0700` |
| `/etc/a4s` | runtime configuration and secrets |
| `~/a4s-deploy/deploy` | host copy of this directory; keep it in sync with the repository |
| `~/a4s-deploy/releases` | host copy of downloaded release archives and `.sha256` files |
| `~/a4s-deploy/backups` | older SQLite backups, superseded by `/opt/a4services/backups` |

The deployer defaults `--archive-dir` to `/opt/a4services/releases`. The host
currently keeps downloads in `~/a4s-deploy/releases` and its wrapper scripts
pass that explicitly, so either location works as long as the archive and its
checksum sit in the same directory.

`~/a4s-deploy/redeploy.sh` deploys several services in one invocation and
requires an explicit version for every app, so it can never fall back to a
stale default version:

```bash
sudo bash ~/a4s-deploy/redeploy.sh idp=<version> bookmarks=<version> \
  rssgrid=<version> tasklists=<version>
```

Deployment stops at the first failure; services deployed before it keep their
new release and the rest are untouched. Release directories are never removed
automatically, so the previous version stays available for a manual rollback
(`ln -sfn <old-version> current.next && mv -Tf current.next current &&
systemctl restart <service>`).

Check what is deployed with `readlink /opt/a4services/*/current` and whether
anything failed with `systemctl list-units --failed`. Nginx and the certificate
are unchanged by a release deployment; they only change when a service is added
or removed.

Comments is prepared but not deployed on this host: the release artifact exists
under `/opt/a4services/comments`, but there is no unit, no `/etc/a4s/comments`
configuration and no DNS record. Enabling it needs a `comments.aggregat4.net`
record, `certbot ... -d comments.aggregat4.net` for the `a4services`
certificate, the unit and configuration from this directory, and the Nginx site
symlink.
