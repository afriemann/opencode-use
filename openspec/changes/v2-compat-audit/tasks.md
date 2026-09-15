## 1. Confirm current V1 hook usage

- [x] 1.1 List every plugin hook registered in `src/index.js` (`tool`,
  `tool.definition`, `tool.execute.before`, `shell.env`,
  `experimental.chat.system.transform`) with a one-line summary of what each
  does — verify by grepping `src/index.js` for the hook keys already
  identified during proposal research.

## 2. Empirically test each hook against opencode2 (opencode-ai@dev)

- [x] 2.1 In a scratch project directory, add an `opencode.json` pointing
  `plugin` at this repo's `src/index.js`, run
  `opencode2 run "<prompt that triggers use_cwd/use_worktree>" --print-logs
  --log-level DEBUG`, and capture the log output — verify by saving the log
  to a temp file and confirming it contains `[opencode-use]`-prefixed lines.
- [x] 2.2 For each hook from task 1.1, determine from the captured log
  whether it fired without error (`tool.definition` → `workdir-capability`
  lines; `tool.execute.before` → workdir injected into a bash call;
  `shell.env` → env vars present in a bash call; `chat.system.transform` →
  injected context visible in the prompt) — verify each hook has a
  pass/fail/not-exercised result with a log excerpt as evidence.
- [x] 2.3 Record the exact `opencode2`/`opencode-ai` dev build version tested
  (`opencode2 --version`) so the audit result is dated and reproducible —
  verify the version string appears in the audit doc.

## 3. Cross-reference against the documented V2 plugin API

- [x] 3.1 Re-read `packages/plugin/src/v2/effect/README.md` and
  `packages/plugin/src/v2/promise/README.md` in a checked-out
  `anomalyco/opencode` source tree and list every documented V2 domain/hook
  (`agent`, `catalog`, `command`, `integration`, `reference`, `skill`
  `.transform()`; `aisdk.sdk`/`aisdk.language` runtime hooks) — verify by
  quoting the exact hook names found.
- [x] 3.2 For each V1 hook, note whether it also appears in the V2-documented
  set, or is confirmed (via task 2) to still run on the V1 runtime in
  parallel — verify each row cites both the empirical result (task 2) and
  the doc cross-reference (task 3.1).

## 4. Write the audit document

- [x] 4.1 Write `docs/v2-compat-audit.md` containing: an overview of what
  opencode V2 is and how to test against it (the `opencode2` sandbox —
  `~/opencode-v2-sandbox`, `opencode-ai@dev`), a table of V1 hooks used by
  this plugin with empirical test result + V2-doc cross-reference + risk
  rating + recommended action per hook — verify the file exists and every
  hook from task 1.1 appears in the table with a dated, evidence-backed
  result (not a source-reading-only inference).
- [x] 4.2 Cross-link the audit doc from the existing
  `work/opencode-use-plugin` memory atom's V2-risk note so future sessions
  find it — verify via `memory_atom_get` that the atom references
  `docs/v2-compat-audit.md`.
