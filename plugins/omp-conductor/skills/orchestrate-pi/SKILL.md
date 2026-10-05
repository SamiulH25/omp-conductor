---
name: orchestrate-pi
description: Use when a task splits into independent pieces that Pi workers can do in parallel (pi_spawn, pi_tools, pi_wait, pi_digest, pi_diff, pi_merge, pi_cleanup). Covers briefing workers, the checks workers run themselves, reviewing real diffs instead of summaries, and merging.
---

# Orchestrating Pi workers

You are the judge. Workers (Pi, one long-lived `pi --mode rpc` process each) do the grunt work; you decide what is accepted.

## Reuse workers: they are RPC processes, not one-shot calls

A finished worker is not gone. Its Pi process stays up (and after 30 idle minutes its saved session is resumed on demand), holding everything it read, ran and learned about the codebase. `pi_send` gives it a new task with all that context intact.

- **Prefer `pi_send` over `pi_spawn`** for fixes, follow-ups and the next task in the same area of the code. A fresh spawn re-reads the same files and re-learns the same layout: that is the churn to avoid.
- Re-spawn only when the approach was wrong, the worker's context is polluted by a bad path, or the new task is in an unrelated part of the project.
- Keep a worker alive while you might still need it: `pi_cleanup` ends its process and forgets it. Merge first (`pi_merge`), then send the next task to the same worker if it builds on the same code.
- A sent message needs no restated background, only the new instruction (it still cannot see this conversation).

## When to use workers

- Use them for independent, well-scoped pieces of work (separate files or features) that can run in parallel, or for bulk work whose raw output you do not want in your context.
- Do not use them for tiny tasks. Spawning, waiting and reviewing costs about 400-500 tokens of your context per worker.

## Agent types

Pick `agent` on `pi_spawn` by what the worker may do:

- `explore`: read-only investigation (where is X, how does Y work, what calls Z). Returns a long `FINDINGS:` report with file:line evidence. Read it as the real answer; it is deliberately not summarized, so keep the question narrow enough that the report is worth its tokens.
- `review`: read-only review of existing code or a worker's output. Returns issues by severity with file:line and a fix.
- `dev`: implements changes in a worktree. Returns a short summary; verify with `pi_diff`.
- `general`: unrestricted, the default when you do not pick. Prefer a specific type.

`explore` and `review` cannot edit or run commands, so they need no worktree and nothing to merge or review beyond their report. Do not give them a task that needs a change; spawn a `dev` worker with their findings in the brief.

## Project dictionary

`pi_dict` keeps a short glossary of the project (term -> definition: what a system is called, what it does, where it lives, conventions). Test and build commands belong in `pi_tools`, not here. It is injected into every worker's system prompt, so workers stop re-learning the project. It is a dictionary, not a log: no task notes, no history.

- **Seed it before the first `pi_spawn`** (a `dev`/`general` spawn is refused until it has entries) for a project, from what you already understand. If you know little, spawn one `explore` worker first, verify its findings, then seed.
- **Add after review**, never before: write only facts you checked yourself (in a diff or a report with file:line evidence). Do not copy a worker's unverified claim into the dictionary; every later worker would inherit the mistake.
- Keep entries to one or two sentences and name file paths. Fix or remove entries that a worker reports as contradicted by the code.
- It is capped (6000 chars total, 300 per entry). If it is full, tighten or remove entries.

## Project toolbox (checks workers run themselves)

`pi_tools` holds the checks (compile, tests, lint) that `dev`/`general` workers are expected to run on their own work, with the `check <name>` command the plugin puts on their PATH. Each worker's prompt lists its toolbox; `required` checks must run after the worker's last edit (the guard reminds it, and the digest shows `checks run:` and warns `required check not run` / `check FAILED`).

- **Workers test their own work.** Never write "do not run the tests / the unity CLI / the editor" in a brief or a dictionary entry. If parallel runs would collide (a Unity project lock, a Gradle daemon), mark the check `serial`: it holds a lock shared by every worker of the project, so they queue instead of colliding.
- **Unity projects get a toolbox by default**: `unity-compile` (required, ~20 s, lists every `error CS####` with file:line), `unity-editmode` (required; workers pass `--filter "Ns.TestClass"` to run only the tests they touched) and `unity-playmode` (optional). All serial; a run held by another batch Unity run waits and retries. Worktree workers get a copy-on-write clone of `Library`, so they do not re-import. Only a Unity editor GUI the user has open on the same project blocks them; workers then report the error instead of guessing.
- **Other projects**: `pi_tools set` the real commands before the first `dev` spawn (e.g. `./gradlew testDebugUnitTest --offline`, `godot --headless -s addons/gut/gut_cmdln.gd`). A check runs from the project root; use `$TMPDIR` for its outputs, `report` for an NUnit/JUnit XML, `log` for an extra log file.
- `checks` on `pi_spawn` overrides which checks are required for one task (`[]` for none, e.g. a docs-only change).
- Still run the full suite yourself after merging.

## Loop

1. **Decompose** into pieces that touch different files. Overlapping pieces will conflict at merge.
2. **Brief** each worker with `pi_spawn`. The brief must stand alone: the worker cannot see this conversation (it does see the project dictionary and its toolbox). State the goal, the files it may touch, which tests cover the change (so it can filter its test check), and "touch no other files". Do not ask for a SUMMARY or FINDINGS block; the plugin adds the right reporting instruction for the agent type.
3. **Wait** with `pi_wait`. A call waits up to 90 seconds; call again while workers are still running. `pi_status` shows live tok/s and cost per worker, plus the session total, if you only need a glance; do not poll it in a loop.
4. **Review** with `pi_digest`, then verify the claims with `pi_diff`. A digest is what the worker says it did plus `git status` taken from the repo. Read the diff before accepting anything that matters.
5. **Judge**:
   - Good: `pi_merge`, then `pi_cleanup`. Add any durable, verified project fact the work revealed to `pi_dict`.
   - Close: `pi_send` a specific correction. The worker's Pi process is still alive (or resumes its saved session after 30 idle minutes), so it already knows the codebase; this is much cheaper than a re-spawn. Wait, review again.
   - Wrong approach: `pi_cleanup` with `force: true` and re-spawn with a better brief.
   - Stuck or runaway: `pi_kill`.
6. **Finish** by running the project's own tests in the merged repo yourself.

## Skills (push what you know onto workers)

Workers start with no skills. Pass `skills` on `pi_spawn` with the ones from your own skill list that match what the task touches, named as you know them (`godot-prompter:state-machine`, a bare name like `save-load`, or a path to a skill dir). Example: a worker writing a Godot enemy FSM gets `godot-prompter:state-machine` and `godot-prompter:ai-navigation`; one editing a Godot HUD gets `godot-prompter:hud-system` and `godot-prompter:godot-ui`. The worker's system prompt lists each one with its path and tells it to read the SKILL.md before working in that area; they stay attached across follow-ups and resumes.

- Push only the skills the task needs (max 8): each one is a read the worker pays for. Workflow skills meant for you (orchestrate-pi, brainstorming, grill, mentor) are not for workers.
- If a follow-up moves the worker into a new area, `pi_send` it with `skills` for that area; they are added to what it has.
- An unknown name is refused with the closest matches; pick from those.

## Verification, time and warnings

- **Tests**: put them in the toolbox (`pi_tools`) so workers run and fix them themselves. Use `verify` (with `fixRounds` 1–2) only for a final gate the worker must not run itself; the plugin runs it after the worker finishes, one at a time, and puts the result in the digest.
- **`expect`**: list the files a task must change. A worker that finishes without touching them is flagged ⚠ in the digest and the wake-up message; a `NO FILES CHANGED` warning means the worker did nothing, whatever it reported.
- **Time**: a timed-out worker reports what it finished. Read that report, then `pi_send` it (with `maxMinutes`) to continue instead of re-spawning.
- **Hard tasks**: raise `effort` for that worker (`pi_spawn` or `pi_send`); the default is low. For the hardest ones (subtle bugs, tricky design, careful reviews) spawn with `codex: true`: that worker runs Codex (the model the user picked with `/codex-worker`, default `openai/gpt-6-luna`, on their ChatGPT subscription) at the `/codex-worker` effort (default xhigh). It is slower, so keep routine edits on the default model.
- **Non-git directories** run in place. `pi_diff` still shows what each worker edited (against saved originals). Workers that share one compile unit will see each other's half-finished files: give them disjoint files and expect transient errors, or run them one after another.
- `pi_wait` returns a one-line status for running workers; use `pi_digest` when you want the full picture of one.

## Rules

- If a spawn is refused with "Pi is not ready", relay the setup steps in the message to the user (Pi must be installed and an OpenCode Go key present); do not try to work around it.
- At most 4 workers run at once. Workers run in their own git worktree and branch by default when the directory is a git repo; non-git directories are edited in place, so keep those workers on disjoint files.
- Workers run with all tool calls auto-approved; `explore` and `review` are safe because they have no write or shell tools, and `dev` and `general` are isolated in worktrees by default. Every run has a hard time limit (`maxMinutes`, default 20).
- `pi_merge` refuses while the main tree has tracked changes, and aborts cleanly on a conflict. On a conflict, `pi_send` the worker a request to rebase onto the current branch, or merge by hand.
- `pi_cleanup` refuses to delete unmerged work unless `force` is true. Never force it without reading the diff.
- A "worker finished" message from the plugin may arrive for a worker you already reviewed. Ignore it.
- Every worker uses the one model the user chose with `/pi-model` (default `opencode-go/deepseek-v4.1-flash`) and the one reasoning effort set with `/pi-effort` (default low). The only per-task choices are `effort`, `skills` and `codex: true` (the `/codex-worker` model and effort). If `pi_spawn` says the ChatGPT sign-in is missing, pass its instructions to the user.
