import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Tuple
from playwright.sync_api import sync_playwright, Playwright, BrowserContext, Page
from app.config import settings
from app.accounts import get_account_profile_dir
from app.selectors import (
    THREADS_BASE_URL,
    LOGGED_IN_INDICATORS,
    LOGGED_OUT_INDICATORS,
)

import sys
logger = logging.getLogger(__name__)

def launch_persistent_browser(
    account: str,
    headless: Optional[bool] = None,
) -> Tuple[Playwright, BrowserContext]:
    """Launch Playwright persistent Chromium context using the account's dedicated session directory."""
    profile_dir = get_account_profile_dir(account, create=True)
    is_headless = settings.HEADLESS if headless is None else headless

    browser_args: list[str] = []
    # Only use --no-sandbox under Linux environments (e.g. Docker container)
    if sys.platform.startswith("linux"):
        browser_args.append("--no-sandbox")

    pw = sync_playwright().start()
    try:
        context = pw.chromium.launch_persistent_context(
            user_data_dir=str(profile_dir),
            headless=is_headless,
            locale="ja-JP",
            viewport={"width": 1280, "height": 800},
            args=browser_args,
            timeout=settings.TIMEOUT_MS,
        )
        return pw, context
    except Exception:
        pw.stop()
        raise

def check_login_state(page: Page, timeout_ms: int = 5000) -> str:
    """Evaluate whether the given page is in a logged-in or logged-out state."""
    try:
        # Navigate to Threads home if not already on Threads
        if "threads.net" not in page.url:
            page.goto(THREADS_BASE_URL, wait_until="domcontentloaded", timeout=timeout_ms)

        page.wait_for_timeout(1000)

        # 1. Check for logged out indicators
        for selector in LOGGED_OUT_INDICATORS:
            if page.locator(selector).first.is_visible():
                return "AUTH_REQUIRED"

        # 2. Check for logged in indicators
        for selector in LOGGED_IN_INDICATORS:
            if page.locator(selector).first.is_visible():
                return "SESSION_OK"

        # 3. Fallback check: URL redirected to login
        if "/login" in page.url:
            return "AUTH_REQUIRED"

        # If on root or feed without login form, likely ok
        return "SESSION_UNKNOWN"
    except Exception as e:
        logger.warning(f"Error checking login state: {e}")
        return "SESSION_UNKNOWN"

def save_diagnostic(page: Page, account: str, stage: str) -> None:
    """Save failure diagnostics (screenshot and metadata) without leaking sensitive tokens or cookies."""
    try:
        ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        safe_stage = stage.replace(" ", "_").lower()
        base_name = f"{ts}_{account}_{safe_stage}"

        settings.DIAGNOSTICS_DIR.mkdir(parents=True, exist_ok=True)
        img_path = settings.DIAGNOSTICS_DIR / f"{base_name}.png"
        meta_path = settings.DIAGNOSTICS_DIR / f"{base_name}.json"

        # Take screenshot safely
        try:
            page.screenshot(path=str(img_path), full_page=False)
        except Exception as e:
            logger.warning(f"Could not take diagnostic screenshot: {e}")

        # Save metadata (no cookies, no tokens)
        metadata = {
            "timestamp": ts,
            "account": account,
            "stage": stage,
            "url": page.url,
            "title": page.title(),
            "screenshot": str(img_path.name),
        }
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(metadata, f, ensure_ascii=False, indent=2)

        logger.info(f"Diagnostic saved: {base_name}")
    except Exception as e:
        logger.warning(f"Failed to record diagnostic: {e}")
