# omp-conductor

A native Codex port is available in [plugins/omp-conductor-codex](plugins/omp-conductor-codex/README.md), with an MCP server and Codex skill. The Claude plugin below remains available.

A Claude Code plugin that lets Claude run several [Pi](https://pi.dev) workers in parallel, read compact digests of their work instead of raw logs, and judge, steer, merge and clean up. Each worker is one long-lived `pi --mode rpc` process, so it can be recalled for fixes without re-learning the codebase.

## Requirements

- **Pi installed and set up.** The plugin warns at session start and refuses to spawn until both are true:
  - `pi` on `PATH` (`npm install -g --ignore-scripts @earendil-works/pi-coding-agent`, Node 22.19+, or `curl -fsSL https://pi.dev/install.sh | sh`)
  - an [OpenCode Go](https://opencode.ai/docs/go/) key, either in `~/.pi-workers/env` as `OPENCODE_GO_API_KEY=<key>` (`chmod 600`) or in the environment (`OPENCODE_GO_API_KEY` or `OPENCODE_API_KEY`)
  - Everything else is created for you in `~/.pi-workers/` on first run (a short worker system prompt, `models.json` for the Go endpoint, `settings.json`). Edit those files to change the worker prompt, add models or change default tools; the plugin never overwrites them.
- `git` (workers get isolated worktrees in git repos)
- Linux or macOS (the `check` runner needs only Node)
- A Claude Code build with function-hook plugins (tested with 2.1.286)

## Install

```
claude plugin marketplace add SamiulH25/omp-conductor#pi-backend
claude plugin install omp-conductor@omp-conductor-marketplace
```

Restart Claude Code, then run `/pi-setup`: it prints the full install guide (Pi, the OpenCode Go key, links) and a checklist of what this machine still needs. Share its output with anyone setting the plugin up.

Restart Claude Code, then ask Claude to spawn workers. The `orchestrate-pi` skill gives it the playbook.

## Two ways to use it

The `orchestrate-pi` skill describes two modes; say which you want.

1. **Orchestrator and quick fixer**: the main model only plans, briefs workers, reads digests and diffs, merges, and makes small fixes itself. Workers do all the implementation (use `pi_plan`, `pi_map`, `pi_race`, `reviewBy`).
2. **Main implementer**: the main model writes the code that needs its judgment and hands workers only tedious, well-bounded side tasks (boilerplate, tests for code it wrote, docs, mechanical migrations, searches, reviews) while it keeps working.

## Tools

| Tool | What it does |
|---|---|
| `pi_spawn` | Start a worker in the background (`task`, `agent`, `dir`, `title`, `maxMinutes`, `worktree`, `effort`, `verify`, `verifyTimeoutSec`, `fixRounds`, `expect`, `checks`, `skills`, `noDict`, `owns`, `after`, `maxCost`, `reviewBy`, `codex`). Returns an id at once, or queues the worker when all 4 slots are busy. `skills` pushes skills Claude has (project/user `.claude/skills` and installed plugins, e.g. `godot-prompter:state-machine`) onto the worker with Pi's `--skill`. A `dev`/`general` worker is refused until the project has a dictionary (`pi_dict`), unless `noDict: true`. |
| `pi_status` | One line per worker, with live tok/s and cost, plus the session total. |
| `pi_digest` | Compact report: files, commands, errors, git status, and the worker's own summary (its own `SUMMARY:` block, or its final reply clipped when it gave none; nothing is summarized by another model). `detail: "full"` adds recent events. |
| `pi_wait` | Blocks (default 300 s, max 900) until something happens, then returns digests of what changed: by default it returns immediately when the first watched worker finishes, fails, is killed, starts after queueing, or gets a new ⚠ warning, so one call replaces many polls. `mode: "all"` waits for every watched worker, `"any"` for the first to finish. |
| `pi_log` | A worker's recent activity (tool calls, errors, text) by event index, to debug a bad run. |
| `pi_race` | Best-of-N: the same task on 2-4 workers (optionally different models); `pi_wait` ranks the results (checks/verify passed, fewer warnings, smaller diff). |
| `pi_map` | One worker per item from a task template with `{item}` (max 20), through the normal queue. Rollup line when all are done. |
| `pi_plan` / `pi_spawn_plan` | A read-only planner turns a goal into a task DAG (`PLAN:` JSON); `pi_spawn_plan` validates it and spawns every task with `after`/`owns` mapped to real worker ids. |
| `pi_notes` | Per-project handoff notes (`show`/`add`/`clear`) injected into every new worker; workers append with the `note` command. |
| `pi_btw` | Ask a running worker why it is taking a long time or has gone quiet, without interrupting it (`id`, optional `question`, `timeoutSec` up to 90, `force` to bypass rate limits). |
| `pi_send` | Follow-up to a finished or timed-out worker (optional `maxMinutes`, `effort`, `skills` to add more). `interrupt: true` aborts a running worker and redirects it in the same process. Goes to its live Pi process, so it keeps everything it learned; after 30 idle minutes the process is stopped and the saved session is resumed instead. Workers are RPC processes, so prefer sending a fix or the next task in the same area to an existing worker over spawning a new one: no re-reading, no re-learning the layout. |
| `pi_diff` | Review a worker's changes: `git diff` plus the content of new files for a worktree worker; for a worker with no worktree (non-git dir, or `worktree:false`) a diff of every file it edited against the original the guard saved, plus the other files changed since the spawn. |
| `pi_merge` | Serialized across workers; runs the required toolbox checks after the merge and reverts it if one fails. Commit the worker's changes (never `__pycache__`/`.pyc`) and merge its branch `--no-ff`. On a conflict the main tree is left untouched and the same conflict is staged as markers in the worker's worktree, so you `pi_send` the worker to resolve it and `pi_merge` again; it refuses to commit while markers remain. |
| `pi_cleanup` | Remove the worktree and branch and forget the worker; refuses unmerged work unless `force`. |
| `pi_dict` | Project dictionary: `show`, `set` (upsert `{term, definition}` entries) or `remove`. Kept per project root (git toplevel) in the plugin store and injected into every worker's system prompt. The orchestrator seeds it before the first spawn and adds only reviewed facts. Capped at 6000 chars, 300 per entry. |
| `pi_tools` | Project toolbox: the checks (compile, tests, lint) workers run themselves with `check <name>`. `show`, `set`, `remove`, `reset`. `required` checks must run after a worker's last edit; `serial` checks hold a project-wide lock so parallel workers queue instead of colliding. Unity projects get `unity-compile`, `unity-editmode` and `unity-playmode` by default. |
| `pi_kill` | Stop a worker and everything it started. |

`/pi-model` shows the current worker model. `/pi-model <name>` switches it (a full `provider/model` selector or part of a name; it searches `pi --list-models`, and asks for the exact selector if several match). `/pi-model reset` restores the default. The choice is kept across sessions and applies to every worker started or resumed afterwards; running workers keep theirs.

`/codex-worker` picks the model for `codex:true` workers: any `openai/*` model in Pi's catalog (ChatGPT sign-in). `/codex-worker` shows it, `/codex-worker list` lists models, `/codex-worker <name> [effort]` sets it (e.g. `/codex-worker gpt-5.3-codex high`), `/codex-worker <effort>` changes only the effort, `/codex-worker reset` restores GPT-6 Luna at xhigh. Applies to codex workers spawned afterwards; running workers keep theirs.

`/pi-model <agentType> <model>` sets a model for one agent type (`general`, `dev`, `explore`, `review`); `/pi-model <agentType> reset` clears it; plain `/pi-model` lists the global model and overrides.

`/pi-budget` shows the session cost cap, `/pi-budget <usd>` sets it, `/pi-budget off` clears it. A per-worker `maxCost` on `pi_spawn` works the same way: at 80% the worker is told to wrap up, at 100% it is stopped and marked budget exceeded (partial work stays reviewable); flat-rate models never trip a budget.

`/pi-agents` lists the agent types, including custom ones from `~/.pi-workers/agents.json` (name -> `{description, tools, prompt, report: "summary"|"findings", worktree?, model?, effort?}`).

`/pi-effort` shows the reasoning effort workers use. `/pi-effort <off|minimal|low|medium|high|xhigh|max>` switches it (Pi `--thinking` levels; Pi clamps to what the model supports). `/pi-effort reset` restores `low`. Kept across sessions and applied to workers started or resumed afterwards.

`/btw <id> [question]` asks a running worker for a separate progress update without steering or interrupting it. Calls are limited to one per worker every 30 seconds and five total unless forced; btw calls are not included in the cost total.

`/conductor` opens a pane (run it again to close it) with a card per worker: an animated avatar (four species, with faces for running, done, failed and stopped), what it is working on, an animated progress bar, live speed (⚡ tok/s with a sparkline), files, tokens, cost and model. A footer keeps the cost, tokens and worker count for the whole session, including workers you have already cleaned up. The avatar reacts to what the worker is doing: eyes sweep while it reads or searches, squint and "type" while it edits, go wide on shell commands, look up with a thinking indicator between tools, and blink slowly after 10 s of silence. One-shot reactions show a wince on a tool error, a smile and ✓ on a file written, and a nod at the end of a turn. A badge beside the face shows the agent type (⌕ explore, ✎ review, ⚒ dev). `/conductor demo` toggles sample workers in every state so you can preview it. The status line shows counts.

## Manager workers

Hand each feature to a **manager** (`pi_spawn { agent: "manager" }`) instead of a plain worker. A manager is a sub-orchestrator: it has no edit tools, decomposes the feature, launches sub-workers with its own tools (`sub_spawn`, `sub_wait`, `sub_status`, `sub_digest`, `sub_diff`, `sub_send`, `sub_merge`, `sub_cleanup`, `sub_kill`, `sub_log`, `sub_btw`, provided by `extensions/manager.ts` over a file bridge), merges their branches into its own integration branch, runs the checks, and reports back for approval. The orchestrator only talks to its direct children (managers and the plain workers it launched itself); sub-workers appear indented in `pi_status` but cannot be addressed. Only managers can launch workers, one level deep. Sub-worker cost rolls up into the manager, `maxCost` covers the whole tree, up to 4 managers run at once, `maxSubWorkers` (default 3) caps a manager's running sub-workers, and killing or cleaning up a manager cascades to its sub-workers.

## agy workers (Antigravity CLI)

`pi_spawn { backend: "agy" }` runs the worker on the Antigravity CLI (`agy`) with your Google AI Pro account instead of Pi, so it can use the Gemini, Claude and GPT-OSS models that account offers. Requires the `antigravity-cli` package, signed in once by running `agy`. `/agy-model` shows the model, `/agy-model list` lists the ids from `agy models`, `/agy-model <name>` sets it (default `gemini-3.8-flash-high`); `model` on `pi_spawn` overrides it for one worker. Reasoning effort is part of the model id (`-low`, `-medium`, `-high`).

An agy worker is one `agy --input-format stream-json` process fed by the same command file as a Pi worker. Its NDJSON events are translated into the events the plugin already reads, so status, digests, `pi_wait`, `pi_log`, `pi_diff`, `pi_merge`, `pi_send` follow-ups (they resume the same conversation), the toolbox `check` runner, the dictionary and shared notes all work unchanged. Cost shows as `plan`. Differences: agy workers always get a git worktree (its plan mode does not enforce read-only), there is no `owns` enforcement or manager role (those need the Pi extensions), and `pi_btw` works differently: agy's own `/btw` is TUI-only, so the answer comes from a separate one-shot `agy` call on a fast model that is given the worker's task, recent events and running tool, and `pi_send` `interrupt` ends the process and resumes the conversation.

## Scheduling, safety and recovery

- **Queue and dependencies**: spawns beyond 4 queue (FIFO); `after: [ids]` starts a worker when its upstream workers are done and passes their reports; a failed upstream fails the dependent clearly.
- **File ownership**: `owns: [globs]` is enforced by the worker guard on edit/write and checked for overlap at spawn and on `pi_send`; `pi_diff` flags files outside it.
- **Review chaining**: `reviewBy` spawns a reviewer on the diff and feeds blocking findings back as fix rounds (`reviewRounds`, default 1).
- **Stuck detection**: no activity for 4 minutes, repeated identical tool calls, or repeated errors raise a ⚠ and ask the worker why (via btw).
- **Persistence**: the worker registry is saved under `~/.pi-workers/registry.json`; after a restart workers come back as interrupted and resume with `pi_send`. Finished workers whose worktree is gone are pruned after 14 days.

## Agent types

`pi_spawn` takes an `agent` type. Each type is a hard tool allowlist (Pi `--tools`, so it is enforced, not just requested), a stated role appended to the system prompt, and a reporting style.

| Type | Tools | Worktree | Reports |
|---|---|---|---|
| `general` (default) | the agent dir's `defaultTools` (read, edit, write, bash, grep) | when in a git repo | Short `SUMMARY:` (the behaviour before agent types) |
| `dev` | read, grep, glob, find, edit, write, bash, todo | when in a git repo | Short `SUMMARY:` of what changed. Told not to commit, push or touch unrelated files |
| `explore` | read, grep, find, ls (read-only) | no | Long `FINDINGS:` report: file:line evidence, quoted code, what was searched and not found, verified vs inferred. Never summarized or compressed |
| `review` | read, grep, find, ls (read-only) | no | `FINDINGS:` ordered by severity, each with file:line, failure scenario and fix. Never summarized or compressed |

Detailed types (`explore`, `review`) show the whole report in `pi_digest` (a 60000-char guard applies; `detail: "full"` raises it to 200000) and a count of files read. The type shows on the worker card. Types are defined in the `AGENTS` table in `hooks/register.tsx`.

## How it talks to Pi

Each worker is one `pi --mode rpc --session-dir ~/.pi-workers/sessions --model <m> --thinking <effort> --offline -ne -ns -np -nc -na [--tools …] [--skill <dir> …] [--append-system-prompt <role + dictionary>]` process with `PI_CODING_AGENT_DIR=~/.pi-workers`. Extensions, skills, prompt templates, `AGENTS.md`/`CLAUDE.md` and project-local `.pi` files are all off, so a worker starts with only the short worker prompt, its tools, the dictionary and any skills the supervisor pushed (`--skill` paths still load with `-ns`).

The plugin API can give a child process a fixed input but not a live stdin, so Pi's stdin is `tail -f` on a per-worker command file (`~/.pi-workers/run/`), and the plugin appends one JSON command per line (`prompt`, `get_state`, `abort`). `tail --pid` ties the pipe to the wrapper, so stopping a worker closes Pi's stdin and Pi shuts down by itself. The plugin reads the JSON event stream from stdout:

- **Run lifecycle:** a run is one `prompt`; `agent_settled` ends it. The process stays up afterwards for `pi_send`.
- **Live speed:** characters from `text`, `toolcall` and `thinking` deltas, converted to tokens with a ratio calibrated against Pi's own usage numbers; the exact rate comes from `usage.output` over the turn's generation time.
- **Work:** `tool_execution_start/end` events give the files touched, commands run, errors and the current activity.
- **Session:** `get_state` provides the session id, kept so a stopped or interrupted worker can be resumed with `--session`.

## Time limits, verification and warnings

- **Time limit** (`maxMinutes`): at 85% the worker is told to wrap up; at 100% it is told to stop and write a partial report (done / not done / files changed) and gets 2 more minutes; only then is it stopped. A timed-out worker ends as `failed` with that report as its last message, and `pi_send` resumes it (pass `maxMinutes` to give it more time).
- **`verify`**: a shell command the plugin runs itself in the worker's directory after the worker finishes, one at a time across all workers (so a real test runner that cannot run in parallel, or that the worker cannot start, still runs). The result goes in the digest. With `fixRounds` (0–3) a failing result is sent back to the worker automatically, with the output tail, to fix.
- **Toolbox checks**: every `dev`/`general` worker gets its project's `pi_tools` checks in its prompt and `bin/check` on its PATH. `check <name> [args]` runs the real command from the project root (args fill `{args}`, e.g. a Unity `--filter`), under a per-project lock for `serial` checks, keeps the full log in the worker's `$TMPDIR` and prints only the verdict, failed tests (from an NUnit/JUnit `report`), error lines (`highlight`) and the log tail. `retryIf` waits out a tool another batch run holds. Runs are recorded and the digest shows `checks run:`; a required check that was not run or failed is a ⚠ warning. For Unity worktree workers the plugin clones `Library` copy-on-write (`cp --reflink=always`), so they skip the full import.
- **Warnings** (⚠ in the digest, `pi_status`, the card and the wake-up message): `NO FILES CHANGED` when a `dev`/`general` worker finishes without modifying anything, `expected change missing: <path>` for each `expect` path left untouched, `required check not run` / `check FAILED`, and `verify FAILED`.
- **Live activity**: the card shows what the worker is thinking or writing right now (tail of the text), the tool call being prepared, and `· quiet Ns` during silent stretches. A running worker's digest shows `now:` instead of a stale earlier message.
- **Scratch files** go to a per-worker `$TMPDIR` under `~/.pi-workers/tmp/` (removed by `pi_cleanup`), not into the project and not into `/tmp`.
- **Cost** shows `plan` for flat-rate plans (the Go models carry no per-token price); the digest reports input tokens with the cached share.

## Worker guard

Every worker loads `extensions/guard.ts` (a Pi extension passed with `-e`; all other extensions stay off). It keeps worktree workers inside their worktree (any path or shell command naming the main repo is redirected, so a brief with an absolute path cannot make a worker edit the main tree), saves originals of edited files for workers with no worktree, applies the matching edits of a multi-edit call and names the one that failed, and blocks a repeated `read` of an unchanged file and repeated identical `grep`/`find`/`ls` when nothing changed in between, and once per run it asks the worker to verify if it changed files and ran nothing afterwards, or to add the `SUMMARY:`/`FINDINGS:` block if the reply lacks it. In 54 benchmark runs it fired once: the base workers rarely repeat themselves, so it is a safety net, not a speed-up.

## Benchmarks

`bench/` holds the harness used to tune the workers (not shipped to users): `bench/run.py` drives Pi RPC over multi-file scenarios in generated repos (feature across files, bug hunt, rename refactor, recall fixes, exploration, a 43-file repo with a do-not-touch file, an unrelated failing test, a prompt-injection file and a 6-step recall chain) and scores each with hidden checks; `bench/flow.py` drives the plugin itself through a headless Claude Code session (3 parallel workers + merges, conflicting workers + hand-off, time limit + resume + kill).

## Behavior

- Every worker runs with the effort set by `/pi-effort`, `low` by default (`DEFAULT_THINKING` in `hooks/register.tsx`).
- Cost comes from Pi's own per-turn usage numbers and is shown on every card, in the digest, in `pi_status`, in the status line and as a session total. The session total lives in session state, so it survives hot reloads and resets with a new session.
- Workers only ever use one model: `opencode-go/deepseek-v4.1-flash` by default (`DEFAULT_MODEL` in `hooks/register.tsx`). Claude cannot pick another per task. The plugin makes no other model calls: digests show what the worker itself reported, and `pi_btw` covers questions about a running worker. Change it with `/pi-model` (below).
- Every task gets its agent type's reporting instruction appended: a short `SUMMARY:` block for `general` and `dev`, a complete `FINDINGS:` report for `explore` and `review`.
- At most 4 concurrent workers, each with a hard time limit (default 20 min; 15 for `explore` and `review`). Directories must be under your home directory or `/tmp`, and not `.ssh`, `.gnupg`, `.aws`, `.kube` or `.docker`.
- Pi has no approval prompts: workers run every tool call with your user's permissions, which is why `dev` and `general` workers run in worktrees by default.
- A wake-up prompt is sent when workers finish and you have not already reviewed them. It is held until Claude's turn ends.
- Worker records are scoped to the Claude session (stored under the session id), so sessions never see or overwrite each other's workers, and the 4-worker cap is per session. They survive a hot reload; a worker that was running is marked "interrupted" and `pi_send` can resume it. Records of sessions untouched for 14 days are pruned. Worktrees stay on disk until `pi_cleanup`.

## Notes

- Worktrees live next to the repo in `.omp-worktrees/`.
- Digest claims are the worker's word plus `git status`. Review `pi_diff` before merging anything important.
- Token cost to the orchestrator is about 400-500 tokens per worker lifecycle, versus about 10k for a raw session.
