# Design

## Decisions

Use anchored ordinary-user-message replay: native publication misses current-request preparation, while dynamic-system fallback defeats prefix stability. Compatibility and routing scope belong to `proposal.md`.

`plugin.v2.js` coordinates state/lifecycle; `context-journal.js` owns persistence/anchoring; `core.js` renders snapshots. Constant system bootstrap and renderer separation implement **V2 Snapshot Authority Separation** and **Advisory System-Prompt Injection** in `specs/context-autoload/spec.md`.

Anchors fingerprint complete unmodified hook-input prefixes using deterministic identity/content normalization and generation/checkpoint/order metadata, including empty-prefix protection. Dormant records preserve original boundaries because staged revert and model-dependent compaction windows can become replayable again; missing anchors alone cannot establish unreachability. These mechanisms implement **Cache-Stable V2 Context Delivery** and **V2 Context History Windows** in `specs/workdir-injection/spec.md`.

A pending-mutation barrier and revision checks across persistence implement **Settled V2 Session Context**. Track canonical host location separately from explicit tool overrides to distinguish native moves from intentional cwd divergence. Replay hydration remains separate from execution-state initialization under **V2 Context Replay Lifecycle**.

The journal schema follows **V2 Context Journal Privacy**. Per-session serialization coordinates replay, persistence and cleanup. Subscribe before the paginated journal-only startup sweep; use per-record authoritative existence reconciliation before replay/write and periodic sweeps to recover missed events.

Deletion handling reads `event.data.sessionID`, closes/increments the lifecycle token before queueing cleanup, drains started writes, then awaits final removal. Lifecycle tokens invalidate queued work. Existence reconciliation/sweeps address crashes and competing-instance races under **V2 Context Journal Erasure**.

Use awaited context-hook Promise rejection for **V2 Context Delivery Failure**: released 2.2.5 propagates rejection before request construction, whereas catch-and-log fulfillment would allow assembly to continue.

## Risks/Trade-offs

Plugin KV lacks session foreign keys and transaction/CAS lifecycle coordination; serialization cannot supply cross-instance atomicity. Exact historical replay trades retained storage for prefix fidelity, precluding arbitrary TTL/rolling eviction. Retention and exhaustion outcomes belong to the privacy and delivery-failure requirements above.
