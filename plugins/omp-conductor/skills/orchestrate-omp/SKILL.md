---
name: orchestrate-omp
description: Use when a task splits into independent pieces that omp workers can do in parallel (omp_spawn, omp_wait, omp_digest, omp_diff, omp_merge, omp_cleanup). Covers briefing workers, reviewing real diffs instead of summaries, and merging.
---

# Orchestrating omp workers

You are the judge. Workers (omp, oh-my-pi, running headless) do the grunt work; you decide what is accepted.

## When to use workers

- Use them for independent, well-scoped pieces of work (separate files or features) that can run in parallel, or for bulk work whose raw output you do not want in your context.
- Do not use them for tiny tasks. Spawning, waiting and reviewing costs about 400-500 tokens of your context per worker.

## Agent types

Pick `agent` on `omp_spawn` by what the worker may do:

- `explore`: read-only investigation (where is X, how does Y work, what calls Z). Returns a long `FINDINGS:` report with file:line evidence. Read it as the real answer; it is deliberately not summarized, so keep the question narrow enough that the report is worth its tokens.
- `review`: read-only review of existing code or a worker's output. Returns issues by severity with file:line and a fix.
- `dev`: implements changes in a worktree. Returns a short summary; verify with `omp_diff`.
- `general`: unrestricted, the default when you do not pick. Prefer a specific type.

`explore` and `review` cannot edit or run commands, so they need no worktree and nothing to merge or review beyond their report. Do not give them a task that needs a change; spawn a `dev` worker with their findings in the brief.

## Project dictionary

`omp_dict` keeps a short glossary of the project (term -> definition: what a system is called, what it does, where it lives, conventions, how to run tests). It is injected into every worker's system prompt, so workers stop re-learning the project. It is a dictionary, not a log: no task notes, no history.

- **Seed it before the first `omp_spawn`** for a project, from what you already understand. If you know little, spawn one `explore` worker first, verify its findings, then seed.
- **Add after review**, never before: write only facts you checked yourself (in a diff or a report with file:line evidence). Do not copy a worker's unverified claim into the dictionary; every later worker would inherit the mistake.
- Keep entries to one or two sentences and name file paths. Fix or remove entries that a worker reports as contradicted by the code.
- It is capped (6000 chars total, 300 per entry). If it is full, tighten or remove entries.

## Loop

1. **Decompose** into pieces that touch different files. Overlapping pieces will conflict at merge.
2. **Brief** each worker with `omp_spawn`. The brief must stand alone: the worker cannot see this conversation (it does see the project dictionary). State the goal, the files it may touch, how to verify (a test command), and "touch no other files". Do not ask for a SUMMARY or FINDINGS block; the plugin adds the right reporting instruction for the agent type.
3. **Wait** with `omp_wait`. A call waits up to 90 seconds; call again while workers are still running. `omp_status` shows live tok/s and cost per worker, plus the session total, if you only need a glance; do not poll it in a loop.
4. **Review** with `omp_digest`, then verify the claims with `omp_diff`. A digest is what the worker says it did plus `git status` taken from the repo. Read the diff before accepting anything that matters.
5. **Judge**:
   - Good: `omp_merge`, then `omp_cleanup`. Add any durable, verified project fact the work revealed to `omp_dict`.
   - Close: `omp_send` a specific correction into the same session (cheaper than a re-spawn), wait, review again.
   - Wrong approach: `omp_cleanup` with `force: true` and re-spawn with a better brief.
   - Stuck or runaway: `omp_kill`.
6. **Finish** by running the project's own tests in the merged repo yourself.

## Rules

- At most 4 workers run at once. Workers run in their own git worktree and branch by default when the directory is a git repo; non-git directories are edited in place, so keep those workers on disjoint files.
- Workers run with all tool calls auto-approved; `explore` and `review` are safe because they have no write or shell tools, and `dev` and `general` are isolated in worktrees by default. Every run has a hard time limit (`maxMinutes`, default 20).
- `omp_merge` refuses while the main tree has tracked changes, and aborts cleanly on a conflict. On a conflict, `omp_send` the worker a request to rebase onto the current branch, or merge by hand.
- `omp_cleanup` refuses to delete unmerged work unless `force` is true. Never force it without reading the diff.
- A "worker finished" message from the plugin may arrive for a worker you already reviewed. Ignore it.
- Every worker uses the one model the user chose with `/omp-model` (default `opencode-go/deepseek-v4.1-flash`) and the one reasoning effort set with `/omp-effort` (default high). You cannot choose a model or effort per task; if a task needs a stronger model or more reasoning, tell the user.
