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
SECRET_CLASSES = {"TRUE_SECRET", "HISTORICAL_TRUE_SECRET", "UNKNOWN_REQUIRES_OPERATOR_REVIEW"}
CLASSIFICATIONS = SECRET_CLASSES | {
    "SYNTHETIC_TEST_FIXTURE",
    "PLACEHOLDER_OR_EXAMPLE",
    "FALSE_POSITIVE",
    "GENERATED_OR_VENDOR",
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

def current_blob_sha(path):
    head = os.environ.get("HEAD_SHA", "HEAD")
    try:
        result = subprocess.run(
            ["git", "rev-parse", f"{head}:{path}"],
            check=False, capture_output=True, text=True, timeout=15,
        )
        value = result.stdout.strip().lower()
        if result.returncode == 0 and re.fullmatch(r"[0-9a-f]{40,64}", value):
            return value
    except Exception:
        pass
    return ""

def finding_fingerprint(commit, path, rule, start, end):
    if not commit:
        return ""
    return f"{commit}:{path}:{rule}:{start}:{end}"

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
        safe.append({
            "path": path, "rule": rule, "start": start, "end": end,
            "commit": commit.lower(),
            "fingerprint": finding_fingerprint(commit.lower(), path, rule, start, end),
            "blob": current_blob_sha(path) if mode == "current" else "",
        })
    if mode == "current" and any(not row["blob"] for row in safe):
        return None, "current tree fingerprint unavailable"
    return (safe, result), None

def load_config():
    config = json.loads(Path(".github/gitleaks-classifications.json").read_text(encoding="utf-8"))
    if config.get("version") != 2 or not isinstance(config.get("findings"), list):
        raise ValueError
    reviewed = {}
    for item in config["findings"]:
        key = (item["path"], item["rule"], int(item["startLine"]), int(item["endLine"]))
        classification, reason = item["classification"], item.get("reason")
        if (
            classification not in CLASSIFICATIONS
            or not isinstance(reason, str) or not reason.strip()
            or key in reviewed
        ):
            raise ValueError
        fingerprints = item.get("fingerprints", [])
        if not isinstance(fingerprints, list) or any(
            not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{7,64}:.+:[^:]+:[0-9]+:[0-9]+", value)
            for value in fingerprints
        ):
            raise ValueError
        blob = item.get("currentBlobSha")
        if blob is not None and (not isinstance(blob, str) or not re.fullmatch(r"[0-9a-f]{40,64}", blob)):
            raise ValueError
        if not fingerprints and not blob:
            raise ValueError
        if classification == "HISTORICAL_TRUE_SECRET" and not fingerprints:
            raise ValueError
        reviewed[key] = {
            "classification": classification,
            "fingerprints": set(fingerprints),
            "currentBlobSha": blob or "",
        }
    return reviewed

def gather():
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
        reviewed = load_config()
    except Exception:
        reviewed = {}
        errors.append("classification file invalid")

    grouped = defaultdict(lambda: {
        "sources": set(), "counts": Counter(), "observations": defaultdict(set)
    })
    for mode, findings in scans.items():
        for item in findings:
            key = (item["path"], item["rule"], item["start"], item["end"])
            group = grouped[key]
            group["sources"].add(mode)
            group["counts"][mode] += 1
            identity = item["blob"] if mode == "current" else item["fingerprint"]
            if identity:
                group["observations"][mode].add(identity)

    output = []
    for key, value in sorted(grouped.items()):
        sources = value["sources"]
        if "pr-range" in sources:
            primary = "pr-range"
            origin = "PR_INTRODUCED"
        elif "current" in sources:
            primary = "current"
            origin = "CURRENT_TREE_ONLY"
        elif "base-history" in sources:
            primary = "base-history"
            origin = "BASE_EXISTING"
        else:
            primary = "history"
            origin = "HISTORY_ONLY"
        config_item = reviewed.get(key)
        observations = value["observations"].get(primary, set())
        classification = "UNKNOWN_REQUIRES_OPERATOR_REVIEW"
        if config_item and observations:
            if primary == "current":
                matches = config_item["currentBlobSha"] and observations == {config_item["currentBlobSha"]}
            else:
                matches = config_item["fingerprints"] and observations.issubset(config_item["fingerprints"])
            if matches:
                classification = config_item["classification"]
                if classification == "HISTORICAL_TRUE_SECRET" and primary not in ("base-history", "history"):
                    classification = "UNKNOWN_REQUIRES_OPERATOR_REVIEW"
        row = {
            "path": key[0], "rule": key[1], "startLine": key[2], "endLine": key[3],
            "origin": origin, "sources": sorted(sources), "historical": bool({"base-history", "history"} & sources),
            "classification": classification,
            "occurrenceCount": value["counts"].get(primary, 1),
        }
        selected_ids = sorted(observations)
        if selected_ids and primary != "current":
            row["commit"] = selected_ids[0].split(":", 1)[0]
            if classification == "UNKNOWN_REQUIRES_OPERATOR_REVIEW":
                row["fingerprintCommits"] = sorted({value.split(":", 1)[0] for value in selected_ids})
        output.append(row)
    return output, errors

def write_findings(rows, errors, heading):
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if not summary_path:
        return
    with open(summary_path, "a", encoding="utf-8") as file:
        file.write(f"## {heading}\n\n")
        file.write("| Path | Rule | Line(s) | Origin | Scans | Classification | Count |\n|---|---|---:|---|---|---|---:|\n")
        for row in rows:
            path = row["path"].replace("|", "\\|")
            rule = row["rule"].replace("|", "\\|")
            line = str(row["startLine"]) if row["startLine"] == row["endLine"] else f"{row['startLine']}-{row['endLine']}"
            file.write(f"| {path} | {rule} | {line} | {row['origin']} | {', '.join(row['sources'])} | {row['classification']} | {row['occurrenceCount']} |\n")
        if errors:
            file.write("\nOne or more scans or the exact-fingerprint classification file could not be validated; raw diagnostics were withheld.\n")

def policy():
    rows, errors = gather()
    print(f"PR Security Gate: {len(rows)} unique sanitized findings.")
    for mode in MODES:
        count = sum(mode in row["sources"] for row in rows)
        print(f"{mode} scan locations: {count}")
    blocking = bool(errors)
    blocked_rows = []
    for row in rows:
        active_sources = {"pr-range", "current"} & set(row["sources"])
        if active_sources and row["classification"] in SECRET_CLASSES:
            blocking = True
            blocked_rows.append(row)
        elif not active_sources and row["classification"] == "UNKNOWN_REQUIRES_OPERATOR_REVIEW":
            blocking = True
            blocked_rows.append(row)
    for row in rows:
        print(json.dumps(row, ensure_ascii=True, sort_keys=True))
    if errors:
        print("One or more required scans or fingerprints could not be validated; diagnostics withheld.")
    print(f"PR_INTRODUCED blocking findings: {sum('pr-range' in row['sources'] for row in blocked_rows)}")
    print(f"CURRENT TREE blocking findings: {sum('current' in row['sources'] for row in blocked_rows)}")
    write_findings(rows, errors, "PR Security Gate")
    if blocking:
        print("PR Security Gate: BLOCKED.")
        return 1
    print("PR Security Gate: PASS.")
    return 0

def audit():
    rows, errors = gather()
    historic = [row for row in rows if row["historical"]]
    exposures = [row for row in historic if row["classification"] == "HISTORICAL_TRUE_SECRET"]
    print(f"Repository Historical Audit: {len(historic)} historical findings reported.")
    print(f"Tracked HISTORICAL_TRUE_SECRET findings: {len(exposures)}")
    for row in exposures:
        print(json.dumps(row, ensure_ascii=True, sort_keys=True))
    if errors:
        print("Historical audit data is incomplete; the PR Security Gate reports scan validation separately.")
    write_findings(historic, errors, "Repository Historical Audit")
    return 0

def cleanup():
    for mode in MODES:
        for extension in ("json", "exit", "log"):
            (TEMP / f"gitleaks-{mode}.{extension}").unlink(missing_ok=True)
    return 0

if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) > 1 else "policy"
    if command == "scan":
        raise SystemExit(scan(sys.argv[2] if len(sys.argv) > 2 else ""))
    if command == "policy":
        raise SystemExit(policy())
    if command == "audit":
        raise SystemExit(audit())
    if command == "cleanup":
        raise SystemExit(cleanup())
    print("Unsupported command.")
    raise SystemExit(2)
