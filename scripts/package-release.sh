#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: scripts/package-release.sh <app> <version> [goos] [goarch] [output-dir]

Apps: rssgrid, bookmarks, comments, idp, tasklists
Version: vMAJOR.MINOR.PATCH or an app-qualified tag such as rssgrid/v1.5.0
Defaults: goos=linux, goarch=amd64, output-dir=dist/releases
EOF
}

if [ "$#" -lt 2 ] || [ "$#" -gt 5 ]; then
  usage
  exit 1
fi

release_repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
release_app=$1
release_version_input=$2
release_goos=${3:-linux}
release_goarch=${4:-amd64}
release_output_dir=${5:-"${release_repo_root}/dist/releases"}

case "${release_app}" in
  rssgrid)
    release_artifact_name=rssgrid
    release_binaries=(rssgrid)
    release_build_commands='go build -trimpath -ldflags="-s -w" -o /out/rssgrid ./apps/rssgrid/cmd/rssgrid'
    ;;
  bookmarks)
    release_artifact_name=bookmarks
    release_binaries=(bmimporter bmserver)
    release_build_commands='go build -trimpath -tags=fts5 -ldflags="-s -w" -o /out/bmserver ./apps/bookmarks/cmd/server
go build -trimpath -tags=fts5 -ldflags="-s -w" -o /out/bmimporter ./apps/bookmarks/cmd/importer'
    ;;
  comments)
    release_artifact_name=comments
    release_binaries=(gocomments-createencryptionkey gocomments-createservice gocomments-server)
    release_build_commands='go build -trimpath -tags=fts5 -ldflags="-s -w" -o /out/gocomments-server ./apps/comments/cmd/runserver
go build -trimpath -tags=fts5 -ldflags="-s -w" -o /out/gocomments-createencryptionkey ./apps/comments/cmd/createencryptionkey
go build -trimpath -tags=fts5 -ldflags="-s -w" -o /out/gocomments-createservice ./apps/comments/cmd/createservice'
    ;;
  idp)
    release_artifact_name=openidprovider
    release_binaries=(createkey createuser server)
    release_build_commands='go build -trimpath -ldflags="-s -w" -o /out/server ./apps/idp/cmd/server
go build -trimpath -ldflags="-s -w" -o /out/createuser ./apps/idp/cmd/createuser
go build -trimpath -ldflags="-s -w" -o /out/createkey ./apps/idp/cmd/createkey'
    ;;
  tasklists)
    release_artifact_name=tasklists
    release_binaries=(tasklists)
    release_build_commands=
    ;;
  *)
    echo "unknown app: ${release_app}" >&2
    usage
    exit 1
    ;;
esac

release_version=${release_version_input}
if [[ "${release_version_input}" == */* ]]; then
  release_tag_app=${release_version_input%%/*}
  release_version=${release_version_input#*/}
  if [ "${release_tag_app}" != "${release_app}" ]; then
    echo "tag namespace ${release_tag_app} does not match app ${release_app}" >&2
    exit 1
  fi
fi

if [[ ! "${release_version}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]]; then
  echo "invalid release version: ${release_version}" >&2
  exit 1
fi

if [ "${release_goos}" != linux ]; then
  echo "deployment packages currently support Linux only" >&2
  exit 1
fi

if [ "${release_app}" != tasklists ] && [ "${release_goarch}" != amd64 ]; then
  echo "${release_app} currently supports deployment packages for linux/amd64 only (CGO build)" >&2
  exit 1
fi

if [ "${release_app}" = tasklists ] && [ "${release_goarch}" != amd64 ] && [ "${release_goarch}" != arm64 ]; then
  echo "tasklists currently supports deployment packages for linux/amd64 and linux/arm64" >&2
  exit 1
fi

mkdir -p "${release_output_dir}"
release_output_dir=$(cd "${release_output_dir}" && pwd)
release_artifact_basename="${release_artifact_name}-${release_version}-${release_goos}-${release_goarch}"
release_artifact_path="${release_output_dir}/${release_artifact_basename}.tar.gz"
release_checksum_path="${release_artifact_path}.sha256"

if [ -e "${release_artifact_path}" ] || [ -e "${release_checksum_path}" ]; then
  echo "release output already exists: ${release_artifact_path}" >&2
  exit 1
fi

release_tmp=$(mktemp -d)
release_payload_dir="${release_tmp}/payload"
mkdir -p "${release_payload_dir}"
release_tasklists_static_dir=
release_tasklists_static_backup=

cleanup() {
  if [ -n "${release_tasklists_static_dir}" ]; then
    rm -rf "${release_tasklists_static_dir}"
    mkdir -p "${release_tasklists_static_dir}"
    if [ -d "${release_tasklists_static_backup}" ]; then
      cp -a "${release_tasklists_static_backup}"/. \
        "${release_tasklists_static_dir}/" 2>/dev/null || true
    fi
  fi
  rm -rf "${release_tmp}"
}
trap cleanup EXIT

if [ "${release_app}" = tasklists ]; then
  release_tasklists_root="${release_repo_root}/apps/tasklists"
  release_tasklists_static_dir="${release_tasklists_root}/server/cmd/server/static"
  release_tasklists_static_backup="${release_tmp}/tasklists-static-backup"
  mkdir -p "${release_tasklists_static_backup}"
  if [ -d "${release_tasklists_static_dir}" ]; then
    cp -a "${release_tasklists_static_dir}"/. \
      "${release_tasklists_static_backup}/" 2>/dev/null || true
  fi

  pnpm --dir "${release_repo_root}" install --frozen-lockfile
  pnpm --dir "${release_tasklists_root}/client" run build

  mkdir -p "${release_tasklists_static_dir}"
  find "${release_tasklists_static_dir}" -mindepth 1 -maxdepth 1 \
    -exec rm -rf {} +
  cp -r "${release_tasklists_root}/client/dist"/. \
    "${release_tasklists_static_dir}/"

  release_go_version=$(awk '$1 == "go" { print $2; exit }' "${release_repo_root}/go.mod")
  release_cache_dir=${A4S_RELEASE_CACHE_DIR:-"${release_repo_root}/.cache/release"}
  mkdir -p "${release_cache_dir}/tasklists-go-build" \
    "${release_cache_dir}/go-mod"
  release_cache_dir=$(cd "${release_cache_dir}" && pwd)
  (
    cd "${release_repo_root}"
    GOTOOLCHAIN="go${release_go_version}" \
      GOCACHE="${release_cache_dir}/tasklists-go-build" \
      GOMODCACHE="${release_cache_dir}/go-mod" \
      GOOS="${release_goos}" GOARCH="${release_goarch}" CGO_ENABLED=0 \
      go build -trimpath \
      -ldflags="-s -w -X main.version=${release_version}" \
      -o "${release_payload_dir}/tasklists" \
      ./apps/tasklists/server/cmd/server
  )
else
  if ! command -v docker >/dev/null 2>&1; then
    echo "docker is required to build ${release_app} against Debian Bookworm" >&2
    exit 1
  fi

  release_go_version=$(awk '$1 == "go" { print $2; exit }' "${release_repo_root}/go.mod")
  release_builder_image=${A4S_GO_BUILDER_IMAGE:-"golang:${release_go_version}-bookworm"}
  release_cache_dir=${A4S_RELEASE_CACHE_DIR:-"${release_repo_root}/.cache/release"}
  mkdir -p "${release_cache_dir}/go-build" "${release_cache_dir}/go-mod"
  release_cache_dir=$(cd "${release_cache_dir}" && pwd)
  release_uid=$(id -u)
  release_gid=$(id -g)

  docker run --rm \
    --platform "${release_goos}/${release_goarch}" \
    --user "${release_uid}:${release_gid}" \
    -e GOOS="${release_goos}" \
    -e GOARCH="${release_goarch}" \
    -e CGO_ENABLED=1 \
    -e GOCACHE=/cache/go-build \
    -e GOMODCACHE=/cache/go-mod \
    -v "${release_repo_root}:/work:ro" \
    -v "${release_payload_dir}:/out" \
    -v "${release_cache_dir}:/cache" \
    -w /work \
    "${release_builder_image}" \
    /bin/bash -euo pipefail -c "${release_build_commands}"
fi

for release_binary in "${release_binaries[@]}"; do
  if [ ! -x "${release_payload_dir}/${release_binary}" ]; then
    echo "expected release binary is missing or not executable: ${release_binary}" >&2
    exit 1
  fi
done

release_payload_count=$(find "${release_payload_dir}" -mindepth 1 -maxdepth 1 | wc -l)
if [ "${release_payload_count}" -ne "${#release_binaries[@]}" ]; then
  echo "release payload contains unexpected files" >&2
  exit 1
fi

release_source_date_epoch=${SOURCE_DATE_EPOCH:-$(git -C "${release_repo_root}" show -s --format=%ct HEAD)}
tar --sort=name --owner=0 --group=0 --numeric-owner \
  --mtime="@${release_source_date_epoch}" \
  -C "${release_payload_dir}" -cf "${release_tmp}/artifact.tar" \
  "${release_binaries[@]}"
gzip -n -c "${release_tmp}/artifact.tar" > "${release_tmp}/${release_artifact_basename}.tar.gz"
mv "${release_tmp}/${release_artifact_basename}.tar.gz" "${release_artifact_path}"

(
  cd "${release_output_dir}"
  sha256sum "$(basename "${release_artifact_path}")" > "$(basename "${release_checksum_path}")"
)

mapfile -t release_archive_entries < <(tar -tzf "${release_artifact_path}")
if [ "${#release_archive_entries[@]}" -ne "${#release_binaries[@]}" ]; then
  echo "release archive contains an unexpected number of entries" >&2
  exit 1
fi
for release_index in "${!release_binaries[@]}"; do
  if [ "${release_archive_entries[release_index]}" != "${release_binaries[release_index]}" ]; then
    echo "release archive has an unexpected layout" >&2
    exit 1
  fi
done

echo "Created ${release_artifact_path}"
echo "Created ${release_checksum_path}"
