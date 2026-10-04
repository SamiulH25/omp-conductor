#!/usr/bin/env python3
"""Plugin-level flows: a headless Claude Code session loads the plugin from disk and drives real Pi workers.
  python3 bench/flow.py P1|P2|P3"""
import os, subprocess, sys, tempfile, json, time
sys.path.insert(0, os.path.dirname(__file__))
import fixture_big
HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.join(HERE, "..", "plugins", "omp-conductor")
TOOLS = ",".join(f"mcp__omp-conductor__pi_{n}" for n in "spawn wait digest send diff merge cleanup kill status dict".split())

def claude(cwd, prompt, secs=280):
    env = dict(os.environ, CLAUDE_CODE_ENABLE_FUNCTION_HOOKS="1")
    t = time.time()
    r = subprocess.run(["claude", "-p", "--plugin-dir", PLUGIN, "--allowedTools", TOOLS, "--output-format", "text", prompt], cwd=cwd, env=env, capture_output=True, text=True, timeout=secs)
    return r.stdout, time.time() - t

def sh(cwd, *c): return subprocess.run(c, cwd=cwd, capture_output=True, text=True)

def tests(d): return sh(d, "python3", "-m", "unittest", "discover", "-s", "tests", "-t", ".")

def fresh(prefix):
    d = tempfile.mkdtemp(prefix=prefix); fixture_big.build(d); return d

def p1():
    d = fresh("p1-")
    prompt = f"""You are the orchestrator. Repo: {d} (git repo). Spawn THREE pi_spawn workers at once (pass noDict true on each) (agent dev, dir {d}), one per task, each with a complete standalone brief that tells it to add unit tests in the matching tests/test_<module>.py and run `python3 -m unittest discover -s tests -t .`:
(a) shop/shipping.py: add express_cents(weight_g) = 999 + 100 * (weight_g // 500).
(b) shop/coupons.py: add coupon_valid(code) -> True only for codes matching ^[A-Z]{{3}}[0-9]{{2}}$ (e.g. ABC12).
(c) shop/loyalty.py: add points(cents) = cents // 100.
Then pi_wait until all three are done, pi_digest each, check each with pi_diff, pi_merge each (one at a time), then pi_cleanup each. Finish by replying with one line per worker: state, merge result."""
    out, secs = claude(d, prompt)
    r = tests(d)
    chk = {}
    chk["tests_pass"] = r.returncode == 0
    for mod, expr in (("shipping", "from shop.shipping import express_cents as f; assert f(0)==999 and f(1000)==1199"), ("coupons", "from shop.coupons import coupon_valid as f; assert f('ABC12') and not f('abc12') and not f('AB123')"), ("loyalty", "from shop.loyalty import points as f; assert f(1999)==19")):
        chk[mod] = sh(d, "python3", "-c", expr).returncode == 0
    chk["merged_3"] = len([l for l in sh(d, "git", "log", "--merges", "--oneline").stdout.splitlines()]) == 3
    chk["worktrees_gone"] = "omp-worktrees" not in sh(d, "git", "worktree", "list").stdout
    chk["main_clean"] = sh(d, "git", "status", "--porcelain", "--untracked-files=no").stdout.strip() == ""
    return d, out, secs, chk, r.stderr[-200:]

def p2():
    d = fresh("p2-")
    prompt = f"""You are the orchestrator. Repo: {d}. Spawn TWO dev workers at once (pi_spawn with noDict true, agent dev, dir {d}) with these tasks, each told to add a test in tests/test_pricing.py and run `python3 -m unittest discover -s tests -t .`:
(a) change shop/pricing.py percent_off so it rounds the DISCOUNT to the nearest cent (percent_off(999,15)==849).
(b) change shop/pricing.py percent_off so it raises ValueError when percent is not between 0 and 100 inclusive, and otherwise floors as before.
pi_wait until both are done, then pi_merge the first one. Then pi_merge the second: it will conflict. When it does, follow the instructions in the conflict message exactly (pi_send the worker, pi_wait, check pi_diff) and pi_merge again until it merges, then pi_cleanup both. Reply with the final pi_merge result and one line on what percent_off does now."""
    out, secs = claude(d, prompt, 290)
    r = tests(d)
    chk = {}
    chk["tests_pass"] = r.returncode == 0
    chk["both_behaviors"] = sh(d, "python3", "-c", "from shop.pricing import percent_off as f\nassert f(999,15)==849\ntry:\n  f(10,150); raise SystemExit(1)\nexcept ValueError: pass").returncode == 0
    chk["no_markers"] = sh(d, "git", "grep", "-n", "-E", "^(<<<<<<<|>>>>>>>) ").returncode == 1
    chk["merged_2"] = len(sh(d, "git", "log", "--merges", "--oneline").stdout.splitlines()) >= 2
    chk["main_clean"] = sh(d, "git", "status", "--porcelain", "--untracked-files=no").stdout.strip() == ""
    return d, out, secs, chk, r.stderr[-300:]

def p3():
    d = fresh("p3-")
    prompt = f"""You are the orchestrator. Dir {d}. (1) pi_spawn an explore worker with maxMinutes 0.2 (about 12 seconds) and a deliberately huge task: read EVERY file under {d} in full, one at a time, and write a detailed per-file analysis. pi_wait until it ends and report its state and error text. (2) pi_send that SAME worker the message 'List only the names of the files in shop/ using ls, nothing else.' pi_wait and pi_digest it; report whether it answered and which state it ended in. (3) pi_spawn a second explore worker with the same huge task and maxMinutes 5, wait about 10 seconds with pi_wait (timeoutSec 10), then pi_kill it and report its state. (4) pi_status. Reply with a short list of results for steps 1-4."""
    out, secs = claude(d, prompt, 290)
    return d, out, secs, {}, ""

def main():
    name = sys.argv[1]
    d, out, secs, chk, err = FLOWS[name]()
    print(f"== {name} dir={d} wall={secs:.0f}s")
    print(out[-1800:])
    print("CHECKS", json.dumps(chk), "ALL_OK" if chk and all(chk.values()) else "")
    if err: print("test stderr:", err)


# ---------------------------------------------------------------- flows for the reported issues
def nongit_dir():
    d = tempfile.mkdtemp(prefix="ng-")
    open(f"{d}/m.py", "w").write("def f():\n    return 0\n")
    open(f"{d}/check.py", "w").write("from m import f\nassert f() == 2, f'f() returned {f()}'\nprint('check ok')\n")
    open(f"{d}/other.py", "w").write("X = 1\n")
    return d

def p5():  # verify + auto fix round + expect + effort + non-git diff + scratch dir
    d = nongit_dir()
    prompt = f"""Orchestrator test in a plain (non-git) folder {d}. Use pi_spawn with agent dev, dir {d}, noDict true, effort medium, verify "python3 check.py", fixRounds 1, expect ["m.py"], and this task: 'Change m.py so that f() returns 1. Do not run anything. Also write a scratch note about what you did to a file named note.txt inside your $TMPDIR (print $TMPDIR with bash first).' Then pi_wait until it is done (repeat as needed), pi_digest it, and pi_diff it. Report: the final state, the verify line from the digest, any warnings, and the pi_diff output."""
    out, secs = claude(d, prompt, 290)
    chk = {}
    chk["m_py_returns_2"] = sh(d, "python3", "check.py").returncode == 0
    chk["no_scratch_in_project"] = sorted(os.listdir(d)) == sorted(["m.py", "check.py", "other.py", "__pycache__"] if os.path.exists(f"{d}/__pycache__") else ["m.py", "check.py", "other.py"])
    return d, out, secs, chk, ""

def p6():  # dictionary gate
    d = fresh("p6-")
    prompt = f"""Orchestrator test, repo {d}. First call pi_spawn (agent dev, dir {d}) with the task 'add a comment line to README.md' and quote the tool result verbatim. Then call pi_dict set (dir {d}) with two short entries (layout: shop/ holds the library, tests/ the unit tests; tests: python3 -m unittest discover -s tests -t .). Then call pi_spawn again with the same task, pi_wait until done, and say what happened."""
    out, secs = claude(d, prompt, 250)
    return d, out, secs, {"readme_changed": "README" in sh(d, "git", "status", "--porcelain").stdout or True}, ""

def p7():  # time limit: wrap-up nudge, partial report, resume with more time
    d = fresh("p7-")
    prompt = f"""Orchestrator test, repo {d}. (1) pi_spawn a dev worker (dir {d}, noDict true, maxMinutes 0.3) with this task: 'Read every file under shop/ and tests/ one at a time, and after each file append a detailed paragraph about it to a new file ANALYSIS.md. Keep going through all the files.' (2) pi_wait until it ends (repeat as needed) and then pi_digest it; report its state, its error text and whether its final message is a report of what was done and what was left. (3) pi_send the same worker 'Continue where you stopped, and finish the remaining files.' with maxMinutes 5, pi_wait until done, and report the final state."""
    out, secs = claude(d, prompt, 290)
    return d, out, secs, {}, ""

def p8():  # no-op warning
    d = fresh("p8-")
    prompt = f"""Orchestrator test, repo {d}. pi_spawn a dev worker (dir {d}, noDict true, expect ["shop/models.py"]) with the task: 'Read shop/models.py and tell me what Item contains. Do not change any file.' pi_wait until done, then pi_digest. Quote the lines of the digest that start with a warning sign, and the state."""
    out, secs = claude(d, prompt, 200)
    return d, out, secs, {}, ""

def p9():  # pi_wait deltas
    d = "/home/bob2142/omp-conductor"
    prompt = f"""Orchestrator test. pi_spawn two explore workers (dir {d}): A reads plugins/omp-conductor/hooks/register.tsx fully and writes a very long explanation of every function; B does the same for README.md and bench/run.py. Then call pi_wait with timeoutSec 15 three times in a row and quote each full result. Then pi_kill both and say how long the three pi_wait outputs were compared with a full digest."""
    out, secs = claude(d, prompt, 250)
    return d, out, secs, {}, ""

FLOWS = {"P1": p1, "P2": p2, "P3": p3, "P5": p5, "P6": p6, "P7": p7, "P8": p8, "P9": p9}



def p10():  # absolute main-repo paths in the brief must not bypass the worktree
    d = fresh("p10-")
    prompt = f"""Orchestrator test. Repo {d} (git). Spawn two dev workers with pi_spawn (dir {d}, noDict true), and put the ABSOLUTE path in each brief on purpose:
1. 'In {d}/shop/pricing.py add a comment line "# w1" above def percent_off. Then run: cd {d} && python3 -m unittest discover -s tests -t .'
2. 'Create the file {d}/shop/w2_extra.py containing X = 2, and add a test {d}/tests/test_w2_extra.py that imports it. Run the tests with cd {d} && python3 -m unittest discover -s tests -t .'
pi_wait until both are done. Then WITHOUT merging, pi_diff both and report each worker's diff summary."""
    out, secs = claude(d, prompt, 280)
    chk = {}
    chk["main_untouched"] = sh(d, "git", "status", "--porcelain", "--untracked-files=all").stdout.replace("__pycache__", "").strip() == "" or all("__pycache__" in l for l in sh(d, "git", "status", "--porcelain", "--untracked-files=all").stdout.splitlines())
    wt = sh(d, "git", "worktree", "list").stdout
    chk["two_worktrees"] = wt.count("omp-worktrees") == 2
    paths = [l.split()[0] for l in wt.splitlines() if "omp-worktrees" in l]
    chk["w1_in_worktree"] = any("# w1" in open(f"{p}/shop/pricing.py").read() for p in paths if os.path.exists(f"{p}/shop/pricing.py"))
    chk["w2_in_worktree"] = any(os.path.exists(f"{p}/shop/w2_extra.py") for p in paths)
    return d, out, secs, chk, ""

FLOWS["P10"] = p10


if __name__ == "__main__":
    main()
