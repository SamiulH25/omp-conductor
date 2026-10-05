# omp-conductor roadmap

Goal: make omp-conductor a real subagent orchestrator. Phase 1 is `/btw`, so the orchestrator can ask a slow worker what it is doing without disturbing it. Later phases follow the feature list from the brainstorm.

## Phase 1: `/btw` and `pi_btw`

### Problem
A worker that runs long gives the orchestrator only `pi_status`/`pi_digest` (what it did) and `pi_send` (a steer that lands after the current turn, becomes part of the worker's context and can derail it). There is no way to ask "what is taking so long?" and get a live answer.

### Design
A Pi extension, `extensions/btw.ts`, loaded into every worker next to `guard.ts` (`-e`). It registers a `/btw <question>` command, and a new MCP tool `pi_btw` sends it.

Facts checked in the Pi docs (`rpc-commands.md`, `extensions.md`):
- A `prompt` that is an extension command executes immediately, even while the agent is streaming. This is what makes mid-run asking possible. `steer` and `follow_up` do not allow extension commands, so the plugin must use `prompt`.
- Extensions can make nested model calls with `ctx.modelRegistry.streamSimple()` and read the session with `ctx.sessionManager.getBranch()`.

How it works:
1. `/btw <q>` handler reads the worker's current branch (task, tool calls, results so far, the in-flight partial turn if available).
2. It makes a separate model call: same model, **no tools**, a short system prompt ("Answer the supervisor's side question about your own progress: what you are doing now, why it is slow, what is left, whether you are stuck. 5 sentences max."). The worker's context is not modified.
3. The answer is written to `$PI_BTW_DIR/<n>.json` (`{q, a, at}`), since it must not enter the worker's conversation.
4. The plugin sends `{type:"prompt", message:"/btw <q>"}` and waits for that file, up to 60 s.

Why a file and not a transcript message: `pi.sendMessage()` would add to the worker's context, which is exactly what `/btw` must avoid. If the docs show a cleaner side channel (the RPC extension UI protocol, `rpc-extension-ui.md`), use that instead. Verify before building.

### Orchestrator side (`register.tsx`)
- New tool `pi_btw { id, question?, wait? }`. Default question: "What exactly are you doing right now, why is it taking this long, what is left, and are you stuck?". Returns the answer plus the worker's last activity and elapsed time. Refuses for a worker that has no live process (use `pi_digest` or `pi_send`).
- New slash command `/btw <id> [question]` for the user, same behaviour.
- Add `w.btwDir` to the worker, create it in `startProc`, pass `PI_BTW_DIR` in env.
- Cost: each ask is one short model call with the full session as input. Record it in the worker's cost. Rate-limit to one ask per worker per 30 s, and cap at 5 per worker unless `force`.
- Skill update (`orchestrate-pi`): when `pi_wait` says a worker is quiet or over its expected time, call `pi_btw` before killing or re-steering it. A btw answer of "stuck" or a loop leads to `pi_send` with a steer or `pi_kill`.

### Auto-btw (optional, after the manual version works)
When a worker has had no progress for N minutes (no new files, same tool repeated), `pi_wait` calls `btw` itself and includes the answer in the wake-up line. This also seeds stuck/loop detection (Phase 4).

### Risks and checks
- The extension command must really run mid-stream. Test with `tests/fake-pi.mjs`-style harness and one real `pi --mode rpc` run with a long bash tool call.
- The nested call must not touch the worker's session file. Check the session file is unchanged after a btw.
- Guard against `/btw` being sent as a normal prompt to a Pi that lacks the extension (resumed old sessions): detect the `handled` disposition; if it comes back `started` or `queued`, abort that run and report that btw is unavailable.
- If the model call fails (rate limit, provider error), return the error text, never hang.

### Done when
- `pi_btw` on a worker mid-bash returns an answer in under 20 s while the worker keeps running.
- The worker's transcript and cost-per-turn are unchanged apart from the btw call being counted.
- `/btw` works from the Claude Code command line.

## Phase 2: scheduling and cost
1. Spawn queue: at `MAX_WORKERS`, queue instead of refusing.
2. Per-agent-type models: `/pi-model explore|dev|review <model>`; codex stays opt-in via `/codex-worker`.
3. Budgets: max cost/tokens per worker and per session, warn at 80%, kill at 100%.
4. Dependencies: `after: [ids]`, upstream digests injected into the downstream brief.

## Phase 3: quality and safety
5. Review chaining: `reviewBy` spawns a reviewer on the diff and feeds findings back through `fixRounds`.
6. File ownership: `owns: [globs]`, overlap rejected at spawn, enforced in `guard.ts`.
7. Merge queue: rebase on main, run required checks after the merge, auto-revert on failure.
8. Best-of-N: race N workers/models, pick by `verify` result or a reviewer.

## Phase 4: control and visibility
9. Persistence: worker registry on disk so `pi_status` can find and resume workers after a restart (`session.end` currently kills them all).
10. Interrupt: `pi_send interrupt:true` aborts a running worker and redirects it.
11. Stuck/loop detection, using btw answers as a signal.
12. `pi_log`: read a worker's event stream by range.

## Phase 5: extensibility
13. `pi_map`: one task template over N targets with a concurrency cap.
14. Planner agent type that outputs a task DAG for approval.
15. User-defined agent types in a config file instead of the `AGENTS` table.
16. Shared handoff notes between workers in a batch.

## Order
Phase 1 first (smallest, directly fixes the "why is it slow" problem). Then the spawn queue, per-type models and budgets from Phase 2, since they are small and cut cost. Persistence (item 9) is the largest change and goes after those. Each phase gets a plugin version bump and README/skill updates.
