#!/usr/bin/env python3
"""Do workers really run in their own git worktrees, and does the main tree stay untouched until merge?"""
import os, subprocess, sys, threading, time, re
sys.path.insert(0, os.path.dirname(__file__))
import flow

d = flow.fresh("wt-")
sub = os.path.join(d, "shop")
slow = "using bash run `sleep 12`, then create the file {f} containing 'hi' at the path given, then run `pwd` and `git branch --show-current` and report both outputs"
prompt = f"""Orchestrator test. Spawn FOUR workers back to back with pi_spawn (pass noDict true on each) (no waiting between spawns):
1. agent dev, dir {d}, title A, task: "{slow.format(f='A.txt')} (create it in the current directory)".
2. agent dev, dir {sub}, title B (a SUBDIRECTORY of the repo), task: "{slow.format(f='B.txt')} (create it in the current directory)".
3. agent general, dir {d}, title C, task: "{slow.format(f='C.txt')} (create it in the current directory)".
4. agent dev, dir {d}, worktree false, title D, task: "{slow.format(f='D.txt')} (create it in the current directory)".
Then pi_wait until all are done and quote each worker's pi_digest 'dir:' line and its SUMMARY. Do NOT merge or clean up anything."""
seen = {}; stop = False; main_dirty = []

def poll():
    while not stop:
        for pid in os.listdir("/proc"):
            if not pid.isdigit(): continue
            try:
                cmd = open(f"/proc/{pid}/cmdline", "rb").read().split(b"\0")
                if b"rpc" in cmd and any(c.endswith(b"pi") or b"/pi" in c for c in cmd[:3]) and b"--mode" in cmd:
                    seen[pid] = os.readlink(f"/proc/{pid}/cwd")
            except Exception: pass
        st = subprocess.run(["git", "status", "--porcelain", "--untracked-files=all"], cwd=d, capture_output=True, text=True).stdout
        st = [l for l in st.splitlines() if "__pycache__" not in l]
        if st: main_dirty.append(st)
        time.sleep(0.7)

t = threading.Thread(target=poll); t.start()
out, secs = flow.claude(d, prompt, 280)
stop = True; t.join()
print(f"wall {secs:.0f}s")
print("Pi process cwds seen while running:")
for pid, cwd in seen.items(): print("  ", cwd)
print("main tree dirty while workers ran:", bool(main_dirty), (main_dirty[0] if main_dirty else ""))
print("git worktree list:"); print(flow.sh(d, "git", "worktree", "list").stdout)
print("branches:", flow.sh(d, "git", "branch", "--list").stdout.split())
for f in ("A", "B", "C", "D"):
    found = subprocess.run(f"find {d} {os.path.dirname(d)}/.omp-worktrees -name {f}.txt -not -path '*/.git/*' 2>/dev/null", shell=True, capture_output=True, text=True).stdout.split()
    print(f"{f}.txt ->", found)
print("---- orchestrator report"); print(out[-1500:])
