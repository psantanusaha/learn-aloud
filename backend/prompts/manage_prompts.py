#!/usr/bin/env python3
"""
Prompt history manager for LearnAloud agent prompts.

Usage:
  python manage_prompts.py list                       # list all agents and versions
  python manage_prompts.py show <agent> [version]     # show prompt (default: current)
  python manage_prompts.py add <agent> <note>         # add new version from stdin
  python manage_prompts.py rollback <agent> <version> # set current_version to an older one
  python manage_prompts.py diff <agent> <v1> <v2>     # diff two versions
"""

import json
import sys
import os
from datetime import date

HISTORY_FILE = os.path.join(os.path.dirname(__file__), "prompt_history.json")


def load():
    with open(HISTORY_FILE) as f:
        return json.load(f)


def save(data):
    with open(HISTORY_FILE, "w") as f:
        json.dump(data, f, indent=2)
    print(f"Saved to {HISTORY_FILE}")


def cmd_list(data):
    for agent, info in data["agents"].items():
        current = info["current_version"]
        versions = sorted(info["versions"].keys())
        print(f"\n  {agent}")
        print(f"    current: {current}")
        for v in versions:
            meta = info["versions"][v]
            marker = " <-- active" if v == current else ""
            print(f"    {v}  ({meta['date']})  {meta['note']}{marker}")


def cmd_show(data, agent, version=None):
    if agent not in data["agents"]:
        print(f"Unknown agent: {agent}")
        print(f"Available: {', '.join(data['agents'].keys())}")
        sys.exit(1)
    info = data["agents"][agent]
    version = version or info["current_version"]
    if version not in info["versions"]:
        print(f"Unknown version: {version}")
        print(f"Available: {', '.join(info['versions'].keys())}")
        sys.exit(1)
    meta = info["versions"][version]
    print(f"--- {agent} {version} ({meta['date']}) ---")
    print(f"Note: {meta['note']}")
    print()
    print(meta["prompt"])


def cmd_add(data, agent, note):
    if agent not in data["agents"]:
        data["agents"][agent] = {"current_version": "v1", "versions": {}}

    info = data["agents"][agent]
    existing = sorted(info["versions"].keys())
    next_num = len(existing) + 1
    next_version = f"v{next_num}"

    print(f"Paste the new prompt for '{agent}' (end with Ctrl+D):")
    prompt_text = sys.stdin.read().strip()
    if not prompt_text:
        print("Empty prompt, aborting.")
        sys.exit(1)

    info["versions"][next_version] = {
        "date": str(date.today()),
        "note": note,
        "prompt": prompt_text,
    }
    info["current_version"] = next_version
    save(data)
    print(f"Added {agent} {next_version} and set as current.")


def cmd_rollback(data, agent, version):
    if agent not in data["agents"]:
        print(f"Unknown agent: {agent}")
        sys.exit(1)
    info = data["agents"][agent]
    if version not in info["versions"]:
        print(f"Unknown version: {version}")
        print(f"Available: {', '.join(info['versions'].keys())}")
        sys.exit(1)
    old = info["current_version"]
    info["current_version"] = version
    save(data)
    print(f"Rolled back {agent}: {old} -> {version}")


def cmd_diff(data, agent, v1, v2):
    if agent not in data["agents"]:
        print(f"Unknown agent: {agent}")
        sys.exit(1)
    info = data["agents"][agent]
    for v in (v1, v2):
        if v not in info["versions"]:
            print(f"Unknown version: {v}")
            sys.exit(1)

    import difflib

    a = info["versions"][v1]["prompt"].splitlines(keepends=True)
    b = info["versions"][v2]["prompt"].splitlines(keepends=True)
    diff = difflib.unified_diff(a, b, fromfile=f"{agent}/{v1}", tofile=f"{agent}/{v2}")
    sys.stdout.writelines(diff)


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    data = load()
    cmd = sys.argv[1]

    if cmd == "list":
        cmd_list(data)
    elif cmd == "show":
        agent = sys.argv[2] if len(sys.argv) > 2 else None
        version = sys.argv[3] if len(sys.argv) > 3 else None
        if not agent:
            print("Usage: manage_prompts.py show <agent> [version]")
            sys.exit(1)
        cmd_show(data, agent, version)
    elif cmd == "add":
        if len(sys.argv) < 4:
            print("Usage: manage_prompts.py add <agent> <note>")
            sys.exit(1)
        cmd_add(data, sys.argv[2], " ".join(sys.argv[3:]))
    elif cmd == "rollback":
        if len(sys.argv) < 4:
            print("Usage: manage_prompts.py rollback <agent> <version>")
            sys.exit(1)
        cmd_rollback(data, sys.argv[2], sys.argv[3])
    elif cmd == "diff":
        if len(sys.argv) < 5:
            print("Usage: manage_prompts.py diff <agent> <v1> <v2>")
            sys.exit(1)
        cmd_diff(data, sys.argv[2], sys.argv[3], sys.argv[4])
    else:
        print(f"Unknown command: {cmd}")
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
