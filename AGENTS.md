# A4S contributor notes

- Keep applications independently buildable and deployable under `apps/`.
- Keep shared Go code under `pkg/`; it must not depend on application code.
- Use the root Taskfile for repository orchestration. Application-specific
  build and test behavior stays with the application.
- Preserve existing behavior during the physical migration. Refactoring,
  dependency upgrades, and deployment changes belong in distinct commits.
