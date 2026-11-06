# Proposal

## Why

Session context changes currently alter V2 system text, disrupting structural reuse of the conversation prefix. Agents still need accurate working context and warnings, including changes caused by other sessions, without stale snapshots or duplicate updates on unchanged tool loops.

## What Changes

- Move V2 dynamic session context and repository advisory delivery into chronological, change-only context snapshots with stable replay positions.
- Preserve context accuracy through pending discovery, host moves, clearing, cross-session environment changes, restart/resume, revert, and compaction. Freshness uses the final settled-hook snapshot boundary defined in `specs/workdir-injection/spec.md`, not physical provider dispatch.
- Introduce session-scoped replay persistence with data-minimization and deletion contracts in `specs/workdir-injection/spec.md`.
- Preserve workdir routing, shell-environment resolution, confidentiality warnings, repository provenance, and subordinate/untrusted advisory framing. V1 transport remains unchanged.
- **BREAKING:** raise the supported V2 plugin peer minimum from `2.0.18` to the verified `2.2.5` release.

## Capabilities

### Modified Capabilities

- `workdir-injection`: V2 context delivery, freshness boundary, chronological replay, and environment-concurrency warning delivery.
- `context-autoload`: advisory replacement/removal and coherent context delivery during session initialization and host moves.

## Impact

Implementation affects the V2 adapter, shared rendering/wording, a focused journal module, approved regression tests, package metadata, and existing usage/compatibility documentation. Validation captures final provider requests from the pinned `2.2.5` CLI against a local fake provider.

OpenCode host modifications, V1 cache-stability changes, environment-routing redesign, provider cache-hit measurement, and billing claims are out of scope. Downstream pinning/deployment follows upstream merge and is not work assigned to this repository's artifacts.
