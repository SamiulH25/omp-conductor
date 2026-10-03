# omp-conductor

A Claude Code plugin that lets Claude run several [omp](https://github.com/can1357/oh-my-pi) (oh-my-pi) workers in parallel, read compact digests of their work instead of raw logs, and judge, steer, merge and clean up.

## Requirements

- `omp` on `PATH`, logged in to a provider (tested with v18.4.5)
- `git` (workers get isolated worktrees in git repos)
- A Claude Code build with function-hook plugins (tested with 2.1.286)

## Install

```
claude plugin marketplace add SamiulH25/omp-conductor
claude plugin install omp-conductor@omp-conductor-marketplace
```

Restart Claude Code, then ask Claude to spawn workers. The `orchestrate-omp` skill gives it the playbook.

## Tools

| Tool | What it does |
|---|---|
| `omp_spawn` | Start a worker in the background (`task`, `agent`, `dir`, `title`, `maxMinutes`, `worktree`). Returns an id at once. |
| `omp_status` | One line per worker, with live tok/s and cost, plus the session total. |
| `omp_digest` | Compact report: files, commands, errors, git status, and the worker's own summary (when a worker gives none and its reply is long, Claude Haiku compresses it, labelled `summary (haiku)`). `detail: "full"` adds recent events. |
| `omp_wait` | Wait up to 90 s for workers, then return digests. |
| `omp_send` | Follow-up in the same omp session (`--resume`). |
| `omp_diff` | `git diff` of a worker's directory, for review. |
| `omp_merge` | Commit the worker's changes and merge its branch `--no-ff`; aborts cleanly on conflict. |
| `omp_cleanup` | Remove the worktree and branch and forget the worker; refuses unmerged work unless `force`. |
| `omp_kill` | Stop a worker and everything it started. |

`/omp-model` shows the current worker model. `/omp-model <name>` switches it (a full `provider/model` selector or part of a name; it searches `omp models`, shows the price, and asks for the exact selector if several match). `/omp-model reset` restores the default. The choice is kept across sessions and applies to every worker started or resumed afterwards; running workers keep theirs.

`/conductor` opens a pane with a card per worker: an animated avatar (four species, with faces for running, done, failed and stopped), what it is working on, an animated progress bar, live speed (⚡ tok/s with a sparkline), files, tokens, cost and model. A footer keeps the cost, tokens and worker count for the whole session, including workers you have already cleaned up. `/conductor demo` toggles sample workers in every state so you can preview it. The status line shows counts.

## Agent types

`omp_spawn` takes an `agent` type. Each type is a hard tool allowlist (omp `--tools`, so it is enforced, not just requested), a stated role appended to the system prompt, and a reporting style.

| Type | Tools | Worktree | Reports |
|---|---|---|---|
| `general` (default) | all | when in a git repo | Short `SUMMARY:` (the behaviour before agent types) |
| `dev` | read, grep, glob, find, edit, write, bash, todo | when in a git repo | Short `SUMMARY:` of what changed. Told not to commit, push or touch unrelated files |
| `explore` | read, grep, glob, find (read-only) | no | Long `FINDINGS:` report: file:line evidence, quoted code, what was searched and not found, verified vs inferred. Never summarized or compressed |
| `review` | read, grep, glob, find (read-only) | no | `FINDINGS:` ordered by severity, each with file:line, failure scenario and fix. Never summarized or compressed |

Detailed types (`explore`, `review`) show the whole report in `omp_digest` (first 6000 chars; `detail: "full"` gives 20000) and a count of files read; the Haiku compression is only ever used for `general` and `dev`. The type shows on the worker card. Types are defined in the `AGENTS` table in `hooks/register.tsx`.

## How it talks to omp

Each worker is `omp -p --mode json --cwd <dir> --approval-mode yolo --thinking high --no-title --max-time <n>m`, and the plugin reads its JSON event stream:

- **Live speed:** characters from `text`, `toolcall` and `thinking` deltas, converted to tokens with a ratio calibrated against omp's own usage numbers. After each turn the exact rate is computed from `usage.output` over `duration - ttft`.
- **Work:** `tool_execution_start/end` events give the files touched, commands run, errors and the current activity.
- **Session:** the `session` event provides the id used by `omp_send`.

## Behavior

- Every worker always runs with `--thinking high` (the `THINKING` constant in `hooks/register.tsx`).
- Cost comes from omp's own per-turn usage numbers and is shown on every card, in the digest, in `omp_status`, in the status line and as a session total. The session total lives in session state, so it survives hot reloads and resets with a new session.
- Workers only ever use one model: `opencode-go/deepseek-v4.1-flash` by default (`DEFAULT_MODEL` in `hooks/register.tsx`). Claude cannot pick another per task. The one other model the plugin touches is Claude Haiku, used only to compress a long worker reply that has no summary of its own (a short call through your Claude session, not an omp worker). Change it with `/omp-model` (below).
- Every task gets its agent type's reporting instruction appended: a short `SUMMARY:` block for `general` and `dev`, a complete `FINDINGS:` report for `explore` and `review`.
- At most 4 concurrent workers, each with a hard time limit (default 20 min; 15 for `explore` and `review`). Directories must be under your home directory or `/tmp`, and not `.ssh`, `.gnupg`, `.aws`, `.kube` or `.docker`.
- Workers auto-approve all tool calls (`--approval-mode yolo`; `write` mode blocks bash in headless runs), which is why they run in worktrees by default.
- A wake-up prompt is sent when workers finish and you have not already reviewed them. It is held until Claude's turn ends.
- Worker records are scoped to the Claude session (stored under the session id), so sessions never see or overwrite each other's workers, and the 4-worker cap is per session. They survive a hot reload; a worker that was running is marked "interrupted" and `omp_send` can resume it. Records of sessions untouched for 14 days are pruned. Worktrees stay on disk until `omp_cleanup`.

## Notes

- Worktrees live next to the repo in `.omp-worktrees/`.
- Digest claims are the worker's word plus `git status`. Review `omp_diff` before merging anything important.
- Token cost to the orchestrator is about 400-500 tokens per worker lifecycle, versus about 10k for a raw session.
