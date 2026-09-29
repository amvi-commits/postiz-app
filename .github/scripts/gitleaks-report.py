#!/usr/bin/env python3
"""Run and summarize Gitleaks scans without exposing raw matches."""
import json
import os
import re
import subprocess
import sys
from collections import Counter, defaultdict
from pathlib import Path

TEMP = Path(os.environ.get("RUNNER_TEMP", "/tmp"))
MODES = ("current", "pr-range", "base-history", "history")
ORIGIN = {
    "base-history": "BASE_EXISTING",
    "pr-range": "PR_INTRODUCED",
    "current": "CURRENT_TREE_ONLY",
    "history": "HISTORY_ONLY",
}
CLASSIFICATIONS = {
    "TRUE_SECRET",
    "SYNTHETIC_TEST_FIXTURE",
    "PLACEHOLDER_OR_EXAMPLE",
    "FALSE_POSITIVE",
    "GENERATED_OR_VENDOR",
    "UNKNOWN_REQUIRES_OPERATOR_REVIEW",
}

def scan(mode):
    if mode not in MODES:
        print("Unsupported scan mode.")
        return 2
    base, head = os.environ.get("BASE_SHA", ""), os.environ.get("HEAD_SHA", "")
    if (mode == "pr-range" and (not base or not head or set(base) == {"0"})) or (
        mode == "base-history" and (not base or set(base) == {"0"})
    ):
        (TEMP / f"gitleaks-{mode}.exit").write_text("SKIPPED", encoding="ascii")
        print(f"{mode} scan skipped: this event has no comparison base.")
        return 0
    report = TEMP / f"gitleaks-{mode}.json"
    status = TEMP / f"gitleaks-{mode}.exit"
    log = TEMP / f"gitleaks-{mode}.log"
    report.write_text("[]", encoding="utf-8")
    binary = os.environ.get("GITLEAKS_BIN", str(TEMP / "gitleaks" / "gitleaks"))
    common = ["--report-format=json", f"--report-path={report}", "--redact=100", "--log-level=fatal"]
    if mode == "current":
        args = [binary, "dir", ".", *common]
    elif mode == "pr-range":
        args = [binary, "git", ".", f"--log-opts={base}..{head}", *common]
    elif mode == "base-history":
        args = [binary, "git", ".", f"--log-opts={base}", *common]
    else:
        args = [binary, "git", ".", "--log-opts=--all", *common]
    try:
        with log.open("wb") as output:
            result = subprocess.run(args, stdout=output, stderr=subprocess.STDOUT, check=False)
        status.write_text(str(result.returncode), encoding="ascii")
        print(f"{mode} scan completed; raw diagnostic output is withheld.")
        return 0
    except Exception:
        status.write_text("ERROR", encoding="ascii")
        print(f"{mode} scan could not be completed; diagnostic output is withheld.")
        return 0
    finally:
        log.unlink(missing_ok=True)

def read_scan(mode):
    report = TEMP / f"gitleaks-{mode}.json"
    status = TEMP / f"gitleaks-{mode}.exit"
    if not report.exists() or not status.exists():
        return None, "missing"
    try:
        rows = json.loads(report.read_text(encoding="utf-8"))
        result = status.read_text(encoding="ascii").strip()
    except Exception:
        return None, "invalid"
    if not isinstance(rows, list):
        return None, "invalid"
    safe = []
    for item in rows:
        if not isinstance(item, dict):
            return None, "invalid"
        path, rule = item.get("File"), item.get("RuleID")
        try:
            start, end = int(item.get("StartLine")), int(item.get("EndLine"))
        except (TypeError, ValueError):
            return None, "invalid"
        if not isinstance(path, str) or not isinstance(rule, str) or start < 1 or end < start:
            return None, "invalid"
        path = "".join(c if c >= " " and c not in "\r\n\t" else " " for c in path)[:1000]
        rule = "".join(c if c >= " " and c not in "\r\n\t" else " " for c in rule)[:200]
        commit = item.get("Commit")
        if not isinstance(commit, str) or not re.fullmatch(r"[0-9a-fA-F]{7,64}", commit):
            commit = ""
        safe.append((path, rule, start, end, commit))
    return (safe, result), None

def summary():
    scans, errors = {}, []
    for mode in MODES:
        result, error = read_scan(mode)
        if error:
            errors.append(f"{mode}: {error}")
            continue
        findings, code = result
        scans[mode] = findings
        if code == "SKIPPED":
            continue
        if not code.isdigit() or int(code) not in (0, 1) or (int(code) == 1 and not findings):
            errors.append(f"{mode}: scanner error")
    required = ["current", "history"]
    if os.environ.get("GITHUB_EVENT_NAME") == "pull_request":
        required += ["pr-range", "base-history"]
    for mode in required:
        if mode not in scans:
            errors.append(f"{mode}: required scan did not run")

    try:
        config = json.loads(Path(".github/gitleaks-classifications.json").read_text(encoding="utf-8"))
        reviewed = {}
        for item in config.get("findings", []):
            key = (item["path"], item["rule"], int(item["startLine"]), int(item["endLine"]))
            classification, reason = item["classification"], item.get("reason")
            if classification not in CLASSIFICATIONS or classification == "UNKNOWN_REQUIRES_OPERATOR_REVIEW" or not isinstance(reason, str) or not reason.strip():
                raise ValueError
            reviewed[key] = classification
    except Exception:
        reviewed, errors = {}, errors + ["classification file invalid"]

    grouped = defaultdict(lambda: {"sources": set(), "counts": Counter(), "commits": set()})
    for mode, findings in scans.items():
        for path, rule, start, end, commit in findings:
            key = (path, rule, start, end)
            grouped[key]["sources"].add(mode)
            grouped[key]["counts"][mode] += 1
            if commit:
                grouped[key]["commits"].add(commit)

    output = []
    for key, value in sorted(grouped.items()):
        if "base-history" in value["sources"]:
            origin, source = "BASE_EXISTING", "base-history"
        elif "pr-range" in value["sources"]:
            origin, source = "PR_INTRODUCED", "pr-range"
        elif "current" in value["sources"]:
            origin, source = "CURRENT_TREE_ONLY", "current"
        else:
            origin, source = "HISTORY_ONLY", "history"
        row = {
            "path": key[0], "rule": key[1], "startLine": key[2], "endLine": key[3],
            "origin": origin,
            "classification": reviewed.get(key, "UNKNOWN_REQUIRES_OPERATOR_REVIEW"),
            "occurrenceCount": value["counts"].get(source, 1),
        }
        commits = sorted(value["commits"])
        if commits and source != "current":
            row["commit"] = commits[0]
        output.append(row)

    origin_counts = Counter(row["origin"] for row in output)
    class_counts = Counter(row["classification"] for row in output)
    print(f"Sanitized Gitleaks findings: {len(output)} unique locations.")
    for key in ORIGIN:
        print(f"{ORIGIN[key]}: {origin_counts.get(ORIGIN[key], 0)}")
    for classification in sorted(CLASSIFICATIONS):
        print(f"{classification}: {class_counts.get(classification, 0)}")
    for row in output:
        print(json.dumps(row, ensure_ascii=True, sort_keys=True))

    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        with open(summary_path, "a", encoding="utf-8") as file:
            file.write("## Gitleaks v8.30.0 sanitized findings\n\n")
            file.write("| Path | Rule | Line(s) | Origin | Classification | Count |\n|---|---|---:|---|---|---:|\n")
            for row in output:
                path = row["path"].replace("|", "\\|")
                rule = row["rule"].replace("|", "\\|")
                line = str(row["startLine"]) if row["startLine"] == row["endLine"] else f"{row['startLine']}-{row['endLine']}"
                file.write(f"| {path} | {rule} | {line} | {row['origin']} | {row['classification']} | {row['occurrenceCount']} |\n")
            if errors:
                file.write("\nA scan was missing or invalid; raw diagnostics were withheld.\n")

    blocked = bool(errors)
    for row in output:
        if row["classification"] == "TRUE_SECRET":
            blocked = True
        if row["origin"] in ("PR_INTRODUCED", "CURRENT_TREE_ONLY") and row["classification"] == "UNKNOWN_REQUIRES_OPERATOR_REVIEW":
            blocked = True
    for mode in MODES:
        for extension in ("json", "exit", "log"):
            (TEMP / f"gitleaks-{mode}.{extension}").unlink(missing_ok=True)
    if errors:
        print("One or more scans could not be validated; details withheld.")
    if blocked:
        print("Gitleaks policy result: BLOCKED.")
        return 1
    print("Gitleaks policy result: PASS.")
    return 0

if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "scan":
        raise SystemExit(scan(sys.argv[2] if len(sys.argv) > 2 else ""))
    raise SystemExit(summary())

