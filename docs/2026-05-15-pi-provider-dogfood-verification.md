# Pi provider dogfood verification — blocked at step 1

Run date: 2026-05-15
Branch: `minions/wf-mp6pbnwm-auapy-400264_t-mp6pbnwm-8aody-4715d1`
Procedure: dogfood the Pi provider against `claude-minions` itself, per the dogfood-loop skill and the project's verification gates.

## Outcome

**Step 1 cannot be attempted. Steps 2–6 are gated on step 1 and were not run.**

Two independent blockers were found. Per the project's no-fallbacks rule (`CLAUDE.md`: "NEVER add fallbacks. […] If you genuinely cannot find the right fix, tell the user directly instead of shipping a fallback") and the task's own acceptance line ("If a step fails, do not paper over it; file the gap and stop"), the run halts here and returns to the planning loop. No mocks, shims, or partial probes were introduced.

## Step-by-step

| Step | Description | Result |
| --- | --- | --- |
| 1 | Boot engine with `MWF_PROVIDER=pi` and confirm `/doctor` reports `pi-version=ok` + `pi-auth=ok`. | **fail** — environment and engine surface both inadequate (see "Blockers"). |
| 2 | Dispatch `mode:think`, `stage:think|plan` read-only audit; confirm THINK allowlist + `--permission-mode plan`. | not attempted (depends on 1). |
| 3 | Dispatch coding session; confirm commit-in-worktree, orchestrator diff-apply, PR open+merge. | not attempted (depends on 1). |
| 4 | Reply-injection probe via continue-task; confirm resumed Pi run picks up new prompt with same `providerSessionRef`. | not attempted (depends on 1). |
| 5 | Crash + recovery: kill engine mid-run, restart, confirm persisted `providerSessionRef` reused and run completes (single final event). | not attempted (depends on 1). |
| 6 | Capture exact strings for quota/rate-limit errors and `unmapped pi type:` warnings. | not attempted — no Pi process ever ran, so no live frames were produced. Parser-surface analysis is below under "Quota and parser-gap surface (static)". |

No transcripts exist to link. No sessions reached `running`.

## Blockers

### Blocker 1 — Pi runtime not provisioned on this host

| Check | Result |
| --- | --- |
| `which pi` | `pi not found` |
| `ls ~/.pi` | `No such file or directory` |
| `npm i -g @earendil-works/pi-coding-agent@0.74.0` | `EROFS` writing `~/.npmrc`; registry also returns `403 Forbidden` for the package GET. Both `~/` outside the sandbox allowlist and the npm proxy block this install. |
| `docker version` | `command not found in this WSL 2 distro` — Docker Desktop integration not enabled; no `/var/run/docker.sock`. The compose deploy that bundles `@earendil-works/pi-coding-agent@0.74.0` in the worker image (`Dockerfile:48–51`) is therefore unreachable. |
| running engine on `MWF_PORT` | none — `ss -tlnp` shows no `:8787`/`:3000` listener. No `pnpm dev:engine`, no `tsx`, no `node` engine process visible. |
| `.env.local` | missing (only `.env.local.example` exists). |

Net: the runtime that `/doctor` would probe doesn't exist. There is no `pi` binary to call `pi --version` against, no `~/.pi/agent/auth.json` to read, and no sandbox-writable path under `/home/prei` for either. Installing Pi or seeding auth requires either (a) Docker Desktop WSL integration on so `docker compose up` runs the worker image, or (b) the operator launching the engine directly from their terminal with Pi already installed and ChatGPT-Codex-authenticated under `~/.pi/agent/auth.json` (per `docker-compose.yml:63` bind-mount). Neither is something this session can perform without paper-over.

### Blocker 2 — Engine has no `pi-version` / `pi-auth` doctor surface

Even with a working Pi runtime mounted, the `/doctor` report cannot return `pi-version=ok` or `pi-auth=ok` because those checks do not exist:

- `packages/shared/src/doctor.ts:3-12` defines `DoctorCheckName` as a closed union of `sqlite-wal | sqlite-busy-timeout | repo-state | worktree-health | tmux-runtime | github-auth | disk-free | dependency-cache | push-config`. No Pi check is in the union.
- `PiProvider.loginStatus()` exists at `packages/engine/src/plugins/providers/pi.ts:302-332` but is never called from the engine. `rg loginStatus packages/engine/src` shows the only references are the interface declaration and per-provider implementations; the doctor builder, the version endpoint, and the engine wiring at `packages/engine/src/engine.ts:539-553` do not invoke it.
- `rg "pi-version|pi-auth"` over the repo: zero hits in any source, config, or test.

So the step-1 acceptance string (`pi-version=ok` and `pi-auth=ok` in `/doctor`) is unsatisfiable as the engine is currently wired. This is a real integration gap in `claude-minions`, independent of my missing Pi binary.

## Gaps to file as follow-up tasks

These are the concrete units of work to dispatch through the loop once the runtime is provisioned. Each is small, ownable by one session, and gated by a deterministic assertion.

1. **Add `pi-version` doctor check.** Extend `DoctorCheckName` in `packages/shared/src/doctor.ts` with `pi-version`. When `process.env["MWF_PROVIDER"] === "pi"`, run `pi --version` (under a 5s timeout) inside `buildDoctorReport`; map non-zero exit / ENOENT to `status: "error"` with the captured stderr in `detail`. Regression test: spawn the engine with `MWF_PROVIDER=pi` and a `PATH` whose `pi` is a fixture script that prints a version, assert `pi-version=ok`; then swap to one that exits 1, assert `pi-version=error`.
2. **Add `pi-auth` doctor check.** Same union extension; the check calls `provider.loginStatus()` on a freshly-constructed `PiProvider` (or threads a single instance through the doctor input). Map `{loggedIn: false}` to `status: "error"` with `details` in `detail`. Regression test: parametrize over `auth.json` fixtures — missing file → `error`, parse error → `error`, OAuth subscription present → `ok`. Mirrors the `PiProvider.loginStatus` cases already covered in `packages/engine/test/plugins/providers/pi.test.ts:548–608`.
3. **Wire the Pi runtime into the host-deploy path.** Either (a) document `npm i -g @earendil-works/pi-coding-agent@0.74.0` + `pi login` as a prerequisite in `README.md`'s Pi section (where the `MWF_PI_*` table lives at line 197), or (b) ship a `scripts/install-pi.sh` and reference it from `bin/engine.sh`. The compose path is fine for production, but the dogfood-loop runs against a host-launched engine and there is currently no on-host install instruction.
4. **Doctor surface integration test.** Add a smoke test under `packages/engine/test/transport/` that hits `GET /doctor` with `MWF_PROVIDER=pi` and asserts both `pi-version` and `pi-auth` appear in the returned `checks` array. Without this, the dogfood-loop's step-1 gate remains a hand-eyeball check.

## Quota and parser-gap surface (static, since no live frames were captured)

Step 6 requires literal Pi-emitted strings. None were produced this run. What's currently encoded in `packages/engine/src/plugins/providers/pi.ts`:

- **Quota detection is shape-based, not string-based.** `isQuotaSignature` (`pi.ts:26-33`) classifies an `error`-typed frame as `kind: "error", source: "quota"` if any of its category/message values matches `/quota/i` OR both `/rate/i` and `/limit/i`. The mapped engine-side message is whatever Pi emitted under `message`. The classifier does not currently match the strings Pi actually emits because nobody has captured a real one. A worked example we should capture and pin in a fixture: the literal `message` and `category` values Pi sends when ChatGPT-Codex returns 429 / "monthly cap reached" / "rate limit exceeded". Until a real frame is recorded, the classifier is theoretical.
- **`unmapped pi type:` fallback.** `pi.ts:290-298` emits a non-recoverable error `unmapped pi type: <type>` for any top-level `type` not in the switch. Known mapped frame types: `session, agent_start, turn_start, message_start, message_update, message_end, queue_update, compaction_start, compaction_end, tool_execution_start, tool_execution_update, tool_execution_end, turn_end, agent_end, auto_retry_start, auto_retry_end, error`. Any frame type Pi adds (or that I missed reading the upstream) will surface as `unmapped pi type:` and become a parser-fix task. The follow-up rule per `feedback_dogfood_verification_gates` is: each captured gap → its own fix session; do not silently patch in the parser.

To unblock step 6 specifically, the operator needs to (a) run Pi once against a non-trivial prompt under heavy reasoning to provoke any new frame kinds, and (b) deliberately drain a sliver of quota (or use a Pi recording fixture if upstream ships one) to capture the literal quota frame. Both require steps 1–3 to pass first.

## Recommended next action

Return to the planning loop with an opus-tier agent. The unit of work is "make Pi dogfood executable on the operator's host". The four follow-up gaps above are the concrete dispatchable scope. Once `/doctor` reports `pi-version=ok` and `pi-auth=ok` on a live engine, re-enter this verification doc and fill in steps 2–6 with transcript links.
