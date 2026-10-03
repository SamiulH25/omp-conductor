---
name: orchestrate-omp
description: Use when a task splits into independent pieces that omp workers can do in parallel (omp_spawn, omp_wait, omp_digest, omp_diff, omp_merge, omp_cleanup). Covers briefing workers, reviewing real diffs instead of summaries, and merging.
---

# Orchestrating omp workers

You are the judge. Workers (omp, oh-my-pi, running headless) do the grunt work; you decide what is accepted.

## When to use workers

- Use them for independent, well-scoped pieces of work (separate files or features) that can run in parallel, or for bulk work whose raw output you do not want in your context.
- Do not use them for tiny tasks. Spawning, waiting and reviewing costs about 400-500 tokens of your context per worker.

## Loop

1. **Decompose** into pieces that touch different files. Overlapping pieces will conflict at merge.
2. **Brief** each worker with `omp_spawn`. The brief must stand alone: the worker cannot see this conversation. State the goal, the files it may touch, how to verify (a test command), and "touch no other files". Do not ask for a SUMMARY block; the plugin adds that instruction itself.
3. **Wait** with `omp_wait`. A call waits up to 90 seconds; call again while workers are still running. `omp_status` shows live tok/s and cost per worker, plus the session total, if you only need a glance; do not poll it in a loop.
4. **Review** with `omp_digest`, then verify the claims with `omp_diff`. A digest is what the worker says it did plus `git status` taken from the repo. Read the diff before accepting anything that matters.
5. **Judge**:
   - Good: `omp_merge`, then `omp_cleanup`.
   - Close: `omp_send` a specific correction into the same session (cheaper than a re-spawn), wait, review again.
   - Wrong approach: `omp_cleanup` with `force: true` and re-spawn with a better brief.
   - Stuck or runaway: `omp_kill`.
6. **Finish** by running the project's own tests in the merged repo yourself.

## Rules

- At most 4 workers run at once. Workers run in their own git worktree and branch by default when the directory is a git repo; non-git directories are edited in place, so keep those workers on disjoint files.
- Workers run with all tool calls auto-approved, which is why worktrees are the default. Every run has a hard time limit (`maxMinutes`, default 20).
- `omp_merge` refuses while the main tree has tracked changes, and aborts cleanly on a conflict. On a conflict, `omp_send` the worker a request to rebase onto the current branch, or merge by hand.
- `omp_cleanup` refuses to delete unmerged work unless `force` is true. Never force it without reading the diff.
- A "worker finished" message from the plugin may arrive for a worker you already reviewed. Ignore it.
- Every worker uses the one model the user chose with `/omp-model` (default `opencode-go/deepseek-v4.1-flash`) and always runs at high reasoning. You cannot choose a model per task; if a task needs a stronger one, tell the user.
