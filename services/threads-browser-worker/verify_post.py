#!/usr/bin/env python3
"""Threads Browser Sidecar Verification & Dry-run CLI Tool.

Enables safe verification of Threads accounts, session state, and post publishing
(with text and optional media attachments) against the local or remote Sidecar service.
By default, this tool operates in dry_run mode (safe mode) and will NOT click the final Post button
unless --real is explicitly specified.
"""

import os
import sys
import json
import uuid
import argparse
from typing import List, Optional
import httpx

def parse_args():
    parser = argparse.ArgumentParser(
        description="Verify Threads Browser Publishing Sidecar session and test publishing safely."
    )
    parser.add_argument(
        "--account",
        required=True,
        help="Account identifier name (must match persistent profile folder name)",
    )
    parser.add_argument(
        "--text",
        default="Threads Browser Sidecar Verification Post",
        help="Message text to submit (default: 'Threads Browser Sidecar Verification Post')",
    )
    parser.add_argument(
        "--media",
        action="append",
        dest="media_items",
        help="Path to local image or public image URL (can be specified multiple times, max 10)",
    )
    parser.add_argument(
        "--is-ghost",
        action="store_true",
        help="Flag to request ephemeral / ghost post (will check native UI)",
    )
    parser.add_argument(
        "--real",
        action="store_true",
        help="Execute a REAL post submission (WARNING: Actually publishes to Threads feed. Default is dry_run mode)",
    )
    parser.add_argument(
        "--url",
        default=os.getenv("THREADS_BROWSER_SERVICE_URL", "http://127.0.0.1:8017"),
        help="Sidecar base URL (default: THREADS_BROWSER_SERVICE_URL or http://127.0.0.1:8017)",
    )
    parser.add_argument(
        "--key",
        default=os.getenv("THREADS_BROWSER_SERVICE_KEY", ""),
        help="Sidecar service key (X-Threads-Service-Key header)",
    )
    return parser.parse_args()


def main():
    args = parse_args()
    base_url = args.url.rstrip("/")
    headers = {"Content-Type": "application/json"}
    if args.key:
        headers["X-Threads-Service-Key"] = args.key

    is_dry_run = not args.real
    mode_label = "DRY-RUN (Safe Mode: stops before clicking Post)" if is_dry_run else "REAL POST (WILL PUBLISH TO FEED)"

    print("=" * 65)
    print(" Threads Browser Sidecar Verification Tool")
    print("=" * 65)
    print(f" Target Service : {base_url}")
    print(f" Target Account : {args.account}")
    print(f" Execution Mode : {mode_label}")
    print(f" Text Message   : {args.text}")
    if args.media_items:
        print(f" Media Items ({len(args.media_items)}):")
        for item in args.media_items:
            print(f"   - {item}")
    print(f" Ghost Post     : {args.is_ghost}")
    print("-" * 65)

    client = httpx.Client(timeout=60.0)

    # Step 1: Check Session Health
    print("[1/2] Checking session authentication state...")
    try:
        check_res = client.post(
            f"{base_url}/api/threads/session/check",
            headers=headers,
            json={"account": args.account},
        )
    except Exception as e:
        print(f"\n[ERROR] Could not connect to Sidecar service at {base_url}: {e}")
        print("Please ensure the Sidecar service is running (`uvicorn app.main:app --port 8017` or via Docker).")
        sys.exit(1)

    if check_res.status_code != 200:
        print(f"\n[FAILED] Session check returned HTTP {check_res.status_code}:")
        try:
            print(json.dumps(check_res.json(), indent=2, ensure_ascii=False))
        except Exception:
            print(check_res.text)
        if check_res.status_code == 404:
            print(f"\nAccount '{args.account}' profile does not exist.")
            print(f"Run manual login first: python cli_login.py {args.account}")
        sys.exit(1)

    session_data = check_res.json()
    session_status = session_data.get("status")
    print(f" -> Session Status: {session_status}")

    if session_status != "SESSION_OK":
        print(f"\n[AUTH REQUIRED] Account '{args.account}' is not logged into Threads (status={session_status}).")
        print(f"Please log in manually via CLI before publishing:")
        print(f"   python cli_login.py {args.account}")
        sys.exit(1)

    print(" -> Session check PASSED (authenticated).")

    # Step 2: Prepare and Dispatch Post Request
    print(f"\n[2/2] Sending publish request ({mode_label})...")
    req_id = f"verify_{uuid.uuid4().hex[:8]}"

    payload = {
        "account": args.account,
        "text": args.text,
        "is_ghost": args.is_ghost,
        "dry_run": is_dry_run,
        "request_id": req_id,
    }

    if args.media_items:
        urls: List[str] = []
        paths: List[str] = []
        for item in args.media_items:
            if item.startswith("http://") or item.startswith("https://"):
                urls.append(item)
            else:
                paths.append(item)
        if urls:
            payload["media_urls"] = urls
        if paths:
            payload["media_paths"] = paths

    try:
        post_res = client.post(
            f"{base_url}/api/threads/post",
            headers=headers,
            json=payload,
        )
    except Exception as e:
        print(f"\n[ERROR] Request to /api/threads/post failed: {e}")
        sys.exit(1)

    print(f" -> Response Status Code: HTTP {post_res.status_code}")
    try:
        res_json = post_res.json()
        print(json.dumps(res_json, indent=2, ensure_ascii=False))
    except Exception:
        print(post_res.text)

    print("-" * 65)
    if post_res.status_code == 200:
        status_val = res_json.get("status")
        if status_val == "dry_run_ok":
            print("[SUCCESS] Dry-run completed successfully! Text & media attachment verified.")
            print("          (No actual post was submitted to Threads feed)")
        else:
            print("[SUCCESS] Real post submitted successfully!")
            if "url" in res_json:
                print(f"          Post URL: {res_json['url']}")
    else:
        print("[FAILED] Publish request was rejected or failed.")
        print("         Check `diagnostics/` folder in services/threads-browser-worker/ for screenshots and error logs.")
        sys.exit(1)


if __name__ == "__main__":
    main()
