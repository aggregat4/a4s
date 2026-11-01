#!/usr/bin/env bash
#
# deploy-service.sh - install one A4 release and switch one service to it.
#
# Usage: sudo deploy-service.sh <app> <version> [options]
#
#   app        bookmarks | idp | rssgrid | tasklists
#   version    v1.9.2 or 1.9.2 (the leading "v" is optional)
#
# Options:
#   --archive-dir DIR   directory holding
#                       <prefix>-<version>-linux-amd64.tar.gz and its .sha256
#                       (default: /opt/a4services/releases)
#   --backup-dir DIR    SQLite backup destination
#                       (default: /opt/a4services/backups, root-only)
#   --dry-run           check prerequisites and print the plan, change nothing
#   -h, --help          show this help
#
# Safety properties, mirroring deploy/README.md:
#   * the archive is verified against its published SHA-256 file before use;
#   * an existing version directory is never overwritten;
#   * the database is copied with the SQLite backup API and the copy is
#     integrity-checked before the service is touched; a transient lock is
#     waited out (busy timeout) and retried up to three times;
#   * the release lives in a new root-owned version directory and `current` is
#     switched with a relative symlink plus an atomic rename;
#   * a failed restart or health check reverts `current`, restarts the previous
#     release and removes the new version directory.
#
# Comments is deliberately not handled: it has no unit, no /etc/a4s
# configuration and no DNS record on the current host.
#
# Exit status: 0 = deployed and verified, 1 = failed (previous release restored).

set -euo pipefail

SERVICES_ROOT=/opt/a4services
DEFAULT_ARCHIVE_DIR=/opt/a4services/releases
DEFAULT_BACKUP_DIR=/opt/a4services/backups

dry_run=0
archive_dir=$DEFAULT_ARCHIVE_DIR
backup_dir=$DEFAULT_BACKUP_DIR
app=
version=

log() { printf '[deploy] %s\n' "$*"; }
die() { printf '[deploy] ERROR: %s\n' "$*" >&2; exit 1; }

usage() { sed -n '3,32p' "$0" | sed 's/^# \{0,1\}//'; }

while [[ $# -gt 0 ]]; do
  case $1 in
    --archive-dir) [[ $# -ge 2 ]] || die "--archive-dir needs a value"; archive_dir=$2; shift 2 ;;
    --backup-dir)  [[ $# -ge 2 ]] || die "--backup-dir needs a value"; backup_dir=$2; shift 2 ;;
    --dry-run)     dry_run=1; shift ;;
    -h|--help)     usage; exit 0 ;;
    -*)            die "unknown option $1 (try --help)" ;;
    *)
      if [[ -z $app ]]; then
        app=$1
      elif [[ -z $version ]]; then
        version=$1
      else
        die "unexpected argument $1"
      fi
      shift ;;
  esac
done

[[ -n $app ]] || { usage; exit 1; }
[[ -n $version ]] || die "missing version (try --help)"

# Canonical deployment facts for one application. Keep in sync with
# scripts/package-release.sh and deploy/systemd/<service>.service.
case $app in
  bookmarks)
    SERVICE=bookmarks; PREFIX=bookmarks
    BINARIES=(bmimporter bmserver); ENTRY=bmserver; DATA_DIR=db; DB_GLOB='*.sqlite'
    PORT=1302; PROBE=/; EXPECT=302 ;;
  idp)
    SERVICE=openidprovider; PREFIX=openidprovider
    BINARIES=(createkey createuser server); ENTRY=server; DATA_DIR=data; DB_GLOB='*.sqlite'
    PORT=1301; PROBE=/status; EXPECT=200 ;;
  rssgrid)
    SERVICE=rssgrid; PREFIX=rssgrid
    BINARIES=(rssgrid); ENTRY=rssgrid; DATA_DIR=data; DB_GLOB='*.db'
    PORT=1400; PROBE=/; EXPECT=302 ;;
  tasklists)
    SERVICE=tasklists; PREFIX=tasklists
    BINARIES=(tasklists); ENTRY=tasklists; DATA_DIR=data; DB_GLOB='*.db'
    PORT=9085; PROBE=/healthz; EXPECT=200 ;;
  comments)
    die "comments is not deployed on this host: it has no unit, no /etc/a4s \
configuration and no DNS record. See deploy/README.md before enabling it." ;;
  *)
    die "unknown app '${app}' (bookmarks|idp|rssgrid|tasklists)" ;;
esac

version=${version#v}
ROOT=${SERVICES_ROOT}/${SERVICE}
TARGET=${ROOT}/${version}
ARCHIVE=${archive_dir}/${PREFIX}-v${version}-linux-amd64.tar.gz
CHECKSUM=${ARCHIVE}.sha256

# ---------------------------------------------------------------- preflight --
if [[ $dry_run -eq 0 ]]; then
  [[ $EUID -eq 0 ]] || die "run as root (sudo)"
else
  log "dry run: no changes will be made"
fi

for tool in tar curl sqlite3 sha256sum systemctl; do
  command -v "$tool" >/dev/null || die "required tool '${tool}' is not installed"
done

[[ -f $ARCHIVE ]] || die "missing archive ${ARCHIVE}"
[[ -f $CHECKSUM ]] || die "missing checksum ${CHECKSUM}"
if [[ $dry_run -eq 0 ]]; then
  ( cd "$archive_dir" && sha256sum -c "$(basename "$CHECKSUM")" ) >/dev/null ||
    die "checksum verification failed for ${ARCHIVE}"
  log "archive checksum ok: $(basename "$ARCHIVE")"
fi

[[ -d $ROOT ]] || die "missing service root ${ROOT}"
[[ -d ${ROOT}/${DATA_DIR} ]] || die "missing state directory ${ROOT}/${DATA_DIR}"
[[ -L ${ROOT}/current ]] || die "no current symlink under ${ROOT}"
[[ ! -e $TARGET ]] || die "${TARGET} already exists; refusing to overwrite"

previous=$(readlink "${ROOT}/current")
[[ -n $previous ]] || die "current symlink under ${ROOT} is not a relative link"
[[ -d ${ROOT}/${previous} ]] || die "current points at missing release ${previous}"
log "${app} ${version}: ${previous} -> ${version} (${ARCHIVE})"

if systemctl is-active --quiet "${SERVICE}.service"; then
  log "service ${SERVICE}.service is active"
else
  log "WARNING: ${SERVICE}.service is not active before deployment"
fi

if [[ $dry_run -eq 1 ]]; then
  log "would unpack into ${TARGET} (root:root), switch ${ROOT}/current, restart ${SERVICE}.service"
  log "would back up ${ROOT}/${DATA_DIR}/${DB_GLOB} into ${backup_dir}"
  log "would verify http://127.0.0.1:${PORT}${PROBE} == ${EXPECT}"
  exit 0
fi

# ------------------------------------------------------- database backup ----
install -d -o root -g root -m 0700 "$backup_dir"
backups=()
shopt -s nullglob
for db in "${ROOT}/${DATA_DIR}/"${DB_GLOB}; do
  [[ -f $db ]] || continue
  dest="${backup_dir}/$(basename "$db").v${previous}-to-v${version}.$(date +%Y%m%dT%H%M%S).bak"
  log "backing up ${db}"
  # The service keeps writing to its database. A momentary exclusive lock (for
  # example during a checkpoint) makes the backup API fail with SQLITE_BUSY,
  # so wait on the busy timeout and retry a few times instead of aborting a
  # deployment for a transient lock.
  attempt=0
  while :; do
    attempt=$((attempt + 1))
    if err=$(sqlite3 "$db" ".timeout 5000" ".backup '${dest}'" 2>&1); then
      break
    fi
    if [[ $attempt -ge 3 ]]; then
      rm -f "$dest"
      die "SQLite backup of ${db} failed after ${attempt} attempts: ${err}"
    fi
    log "backup attempt ${attempt} failed (${err}); retrying"
    sleep "$attempt"
  done
  chmod 0600 "$dest"
  result=$(sqlite3 "$dest" "PRAGMA integrity_check;")
  [[ $result == ok ]] || die "integrity check of ${dest} reported: ${result}"
  backups+=("$dest")
done
shopt -u nullglob
[[ ${#backups[@]} -gt 0 ]] || log "WARNING: no database file matched ${ROOT}/${DATA_DIR}/${DB_GLOB}"
for b in "${backups[@]}"; do log "verified backup: ${b}"; done

# ---------------------------------------------------------------- install ---
install -d -o root -g root -m 0755 "$TARGET"
tar -xzf "$ARCHIVE" -C "$TARGET" || { rm -rf "$TARGET"; die "failed to unpack ${ARCHIVE}"; }
chown -R root:root "$TARGET"
for bin in "${BINARIES[@]}"; do
  if [[ -e ${TARGET}/${bin} ]]; then
    chmod 0755 "${TARGET}/${bin}"
  else
    rm -rf "$TARGET"
    die "release does not contain expected binary '${bin}'"
  fi
done
[[ -x ${TARGET}/${ENTRY} ]] || { rm -rf "$TARGET"; die "${ENTRY} is not executable"; }
log "installed ${TARGET}"

# ----------------------------------------------------------- switch + probe -
activated=0
rollback() {
  log "deployment failed - rolling back to ${previous}"
  ln -sfn "$previous" "${ROOT}/current.next"
  mv -Tf "${ROOT}/current.next" "${ROOT}/current"
  systemctl restart "${SERVICE}.service" || true
}
cleanup() {
  rc=$?
  [[ $rc -eq 0 ]] && return 0
  if [[ $activated -eq 1 ]]; then rollback; fi
  [[ -d $TARGET ]] && rm -rf "$TARGET"
  return 0
}
trap cleanup EXIT

log "switching current -> ${version}"
ln -sfn "$version" "${ROOT}/current.next"
mv -Tf "${ROOT}/current.next" "${ROOT}/current"
activated=1

systemctl restart "${SERVICE}.service"
code=000
for _ in $(seq 1 20); do
  code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:${PORT}${PROBE}" || true)
  [[ $code == "$EXPECT" ]] && break
  sleep 1
done
systemctl is-active --quiet "${SERVICE}.service" ||
  die "${SERVICE}.service did not stay active"
[[ $code == "$EXPECT" ]] ||
  die "health check failed: http://127.0.0.1:${PORT}${PROBE} returned ${code}, expected ${EXPECT}"

trap - EXIT
log "deployed ${app} v${version} (previous ${previous})"
if [[ ${#backups[@]} -gt 0 ]]; then log "database backup: ${backups[0]}"; fi
exit 0
