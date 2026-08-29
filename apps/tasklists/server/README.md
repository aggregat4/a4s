# Server

Go backend for sync and static hosting. Endpoints match
`../specs/protocol-spec.md`.

Repository-wide setup lives in the root `README.md`. Deployment, runtime
configuration, and release packaging live in `../docs/deployment.md`.

## Run

From the repository root:

```
./apps/tasklists/scripts/run-local.sh
```

## Build and Test

From the repository root:

```bash
task tasklists:build
task tasklists:test
task lint
```
