# Production migration runbook

This runbook records the one-time transition from the current host to the
canonical deployment described by `deploy/README.md`. It is intentionally
separate from the steady-state deployment documentation: the history is useful
for review and disaster recovery, but these are not recurring deployment steps.

Make the changes during maintenance windows and migrate one service at a time.
Do not combine the service-account, configuration, binary, database, and Nginx
switches for all applications into one large cutover.

## Current-to-target summary

| Concern | Current host | Canonical target |
| --- | --- | --- |
| Service identity | services run as root | one `a4-*` system account per service |
| Configuration | mostly under `/opt/a4services` | `/etc/a4s` with restricted ownership |
| Releases | version directories plus `current` | retained unchanged |
| SQLite state | service-local `db`/`data` | retained, owned only by service account |
| Tasklists name | `a4tasklists` | `tasklists` directory and unit |
| Nginx | one monolithic `default` site | one site per service plus shared snippets |
| TLS | certificate named after the retired Capture service | certificate named `a4services` |
| Comments | artifact present but not deployed | prepare only when ready to deploy |

## Preflight and backups

Before changing a service:

1. Record `systemctl cat <service>` and the target of its `current` symlink.
2. Save its live environment/configuration with permissions that prevent other
   users from reading secrets.
3. Stop the service before changing SQLite ownership or moving its directory.
4. Create a consistent SQLite backup and verify it with `PRAGMA integrity_check`.
5. Keep the old unit, configuration, release directory, and certificate until
   the replacement has survived an observation period.

For an individual database, use the SQLite backup API after stopping its
service:

```bash
sudo install -d -m 0700 /opt/a4services/migration-backup-YYYYMMDD
sudo sqlite3 /path/to/live.db \
  ".backup '/opt/a4services/migration-backup-YYYYMMDD/service.db'"
sudo sqlite3 /opt/a4services/migration-backup-YYYYMMDD/service.db \
  'PRAGMA integrity_check;'
```

Replace `YYYYMMDD` and the database paths explicitly. Continue only when the
integrity check reports `ok`.

## Accounts, directories, and configuration

Use the commands in the committed deployment README to create the five
`/usr/sbin/nologin` accounts and target directories. Creating these accounts
does not change a running service until its new unit is installed and started.

Prepare configuration from the committed templates, but preserve all existing
secret values and the OpenID Provider signing key pair:

- Move Bookmarks configuration to `/etc/a4s/bookmarks.env`. Its binary now
  accepts systemd-provided variables without requiring a local `.env`.
- Move RSSGrid's non-secret JSON to `/etc/a4s/rssgrid/rssgrid.json` and its
  session/OIDC secrets to `/etc/a4s/rssgrid.env`.
- Copy the OpenID Provider configuration to
  `/etc/a4s/openidprovider/openidprovider.json`, update its database/key paths,
  and copy the existing `private.pem` and `public.pem` unchanged into that
  directory. Do not generate a replacement key pair.
- Move Tasklists configuration from
  `/opt/a4services/a4tasklists/.env` to `/etc/a4s/tasklists.env`, preserving its
  OIDC and session secrets while changing the database path to the canonical
  `tasklists` directory.
- Leave Comments disabled until its configuration, OIDC registration, DNS, and
  certificate name are ready.

Install each file with the owner and mode documented in `deploy/README.md`.
Never copy example placeholder values over working production secrets.

## Migrate each existing service away from root

For Bookmarks, OpenID Provider, and RSSGrid, repeat this pattern individually:

1. Stop the old unit.
2. Back up and verify its SQLite database.
3. Give only the service's `db` or `data` directory to its new account. Keep
   release versions and `current` owned by `root:root`.
4. Install the external configuration and canonical unit.
5. Run `systemd-analyze verify` and `systemctl daemon-reload`.
6. Start the unit, inspect `systemctl status` and `journalctl`, then perform a
   local and public application smoke test.
7. Roll back to the old unit and ownership if validation fails.

Do not recursively assign the whole service directory to the service account;
that would allow a compromised process to replace the executable selected by
`current`.

## Tasklists naming and account migration

This is the one-time, rollback-safe change from `a4tasklists.service` and
`/opt/a4services/a4tasklists` to `tasklists.service` and
`/opt/a4services/tasklists`. New monorepo releases contain a `tasklists`
executable; older releases contain `a4-tasklists`, so the directory and binary
changes must be switched together.

### Prepare

1. Record `readlink /opt/a4services/a4tasklists/current` and save the old unit
   and `.env` contents.
2. Check the `.env` file and any scripts for absolute `a4tasklists` paths.
3. Create the `a4-tasklists` account and canonical directories.
4. Install `/etc/a4s/tasklists.env` as `root:a4-tasklists` mode `0640` with the
   existing secrets and new database path.
5. Install `deploy/systemd/tasklists.service` as
   `/etc/systemd/system/tasklists.service`.
6. Build or download a new monorepo Tasklists release, verify its checksum, and
   confirm that its only archive entry is the root-level `tasklists`
   executable. Keep the archive available for the maintenance window.

### Switch

```bash
TASKLISTS_NEW_VERSION=1.5.0
TASKLISTS_ARCHIVE=/path/to/tasklists-v1.5.0-linux-amd64.tar.gz
sha256sum -c "${TASKLISTS_ARCHIVE}.sha256"
sudo systemctl stop a4tasklists.service
sudo install -d -m 0700 /opt/a4services/tasklists-name-backup-YYYYMMDD
sudo sqlite3 /opt/a4services/a4tasklists/data/a4-tasklists.db \
  ".backup '/opt/a4services/tasklists-name-backup-YYYYMMDD/a4-tasklists.db'"
sudo sqlite3 /opt/a4services/tasklists-name-backup-YYYYMMDD/a4-tasklists.db \
  'PRAGMA integrity_check;'
sudo mv /opt/a4services/a4tasklists /opt/a4services/tasklists
sudo chown -R a4-tasklists:a4-tasklists /opt/a4services/tasklists/data
sudo install -d -o root -g root -m 0755 \
  "/opt/a4services/tasklists/${TASKLISTS_NEW_VERSION}"
sudo tar -xzf "${TASKLISTS_ARCHIVE}" \
  -C "/opt/a4services/tasklists/${TASKLISTS_NEW_VERSION}"
sudo chown -R root:root "/opt/a4services/tasklists/${TASKLISTS_NEW_VERSION}"
sudo chmod 0755 \
  "/opt/a4services/tasklists/${TASKLISTS_NEW_VERSION}/tasklists"
cd /opt/a4services/tasklists
sudo ln -sfn "${TASKLISTS_NEW_VERSION}" current.next
sudo mv -Tf current.next current
sudo ln -s tasklists /opt/a4services/a4tasklists
sudo systemctl daemon-reload
sudo systemctl start tasklists.service
```

Continue only when the integrity check reports `ok`. The temporary
compatibility symlink keeps unexpected old absolute references working while
the new service is verified. Set the version and archive variables to the exact
release being deployed.

```bash
sudo systemctl status tasklists.service
curl --fail http://127.0.0.1:9085/healthz
sudo journalctl -u tasklists.service --since today
```

Also load the public application, log in, make a small change, and reload it to
confirm that existing data is present and persistence works. Nginx remains on
port 9085, so it does not need a simultaneous routing change.

After the observation period:

```bash
sudo systemctl enable tasklists.service
sudo systemctl disable a4tasklists.service
sudo unlink /opt/a4services/a4tasklists
```

Keep the old unit file until a later cleanup pass.

### Tasklists rollback

If verification fails, stop the new unit, point `current` back at the old
release recorded during preparation, restore the original directory name, and
restart the old unit. This is necessary because the old unit expects the old
release's `a4-tasklists` executable:

```bash
TASKLISTS_OLD_VERSION=1.4.0
sudo systemctl stop tasklists.service
cd /opt/a4services/tasklists
sudo ln -sfn "${TASKLISTS_OLD_VERSION}" current.next
sudo mv -Tf current.next current
sudo unlink /opt/a4services/a4tasklists
sudo mv /opt/a4services/tasklists /opt/a4services/a4tasklists
sudo systemctl start a4tasklists.service
```

Set `TASKLISTS_OLD_VERSION` to the exact target recorded before the migration.

If the new binary applied an incompatible schema migration, restore the
verified database backup before starting the old release.

## Certificate and Nginx migration

The live Nginx `default` site currently contains all proxies and refers to a
certificate named after the retired Capture service. Preserve that loaded
configuration while preparing its replacement.

Issue a new certificate named `a4services` for the four currently deployed
names. Do not include Comments until its DNS and service are ready:

```bash
sudo certbot certonly --nginx --cert-name a4services \
  -d openidprovider.aggregat4.net \
  -d bookmarks.aggregat4.net \
  -d rssgrid.aggregat4.net \
  -d tasklists.aggregat4.net
```

Install the committed shared Nginx files and site definitions. Enable only the
four deployed sites, then remove the `sites-enabled/default` symlink while
leaving its `sites-available/default` file intact for rollback:

```bash
sudo install -m 0644 deploy/nginx/conf.d/a4-rate-limits.conf /etc/nginx/conf.d/
sudo install -m 0644 deploy/nginx/snippets/*.conf /etc/nginx/snippets/
sudo install -m 0644 deploy/nginx/sites/*.conf /etc/nginx/sites-available/
sudo ln -s /etc/nginx/sites-available/bookmarks.conf /etc/nginx/sites-enabled/bookmarks.conf
sudo ln -s /etc/nginx/sites-available/openidprovider.conf /etc/nginx/sites-enabled/openidprovider.conf
sudo ln -s /etc/nginx/sites-available/rssgrid.conf /etc/nginx/sites-enabled/rssgrid.conf
sudo ln -s /etc/nginx/sites-available/tasklists.conf /etc/nginx/sites-enabled/tasklists.conf
sudo unlink /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

If `nginx -t` fails, restore the default symlink, remove the newly enabled site
symlinks, and leave Nginx running with its previously loaded configuration.
Do not delete the old certificate until renewal and application checks for the
new certificate succeed.

## Final cleanup

After all services and Nginx have survived an observation period:

- remove obsolete unit files and retired compatibility symlinks;
- remove superseded configuration copies under `/opt/a4services` only after
  confirming the units no longer reference them;
- retain at least one previous release and verified database backup;
- inspect `systemctl list-units --failed`, application logs, and Certbot renewal
  status before considering the migration complete.
