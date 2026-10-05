"""Smoke test to verify Playwright can launch headless browser on the current machine."""

import pytest
from playwright.sync_api import sync_playwright


def test_playwright_launch_smoke():
    """Verify Playwright can start, launch Chromium headless, open about:blank, and close cleanly."""
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            context = browser.new_context()
            page = context.new_page()
            page.goto("about:blank")
            assert page.url == "about:blank"
            context.close()
            browser.close()
    except Exception as e:
        # If Playwright browser binaries are not installed on the host environment,
        # skip with an informative message rather than failing unit tests.
        if "Executable doesn't exist" in str(e) or "playwright install" in str(e):
            pytest.skip(f"Playwright browser binary not installed on host: {e}")
        else:
            raise


def test_api_session_check_real_playwright_no_event_loop_conflict(tmp_path, monkeypatch):
    """Verify that calling POST /api/threads/session/check through FastAPI TestClient
    executes real sync_playwright() on the threadpool without raising the asyncio loop conflict error."""
    from fastapi.testclient import TestClient
    from app.main import app
    from app.config import settings
    from app.accounts import get_account_profile_dir
    from unittest.mock import patch

    monkeypatch.setattr(settings, "SESSIONS_DIR", tmp_path)
    monkeypatch.setattr(settings, "SERVICE_KEY", "smoke-test-key")
    get_account_profile_dir("smoke_user", create=True)

    # Allow launch_persistent_browser to invoke real sync_playwright() and real Chromium launch,
    # but mock check_login_state to avoid needing internet connectivity to threads.net.
    try:
        with patch("app.main.check_login_state", return_value="SESSION_OK"):
            client = TestClient(app)
            res = client.post(
                "/api/threads/session/check",
                json={"account": "smoke_user"},
                headers={"X-Threads-Service-Key": "smoke-test-key"},
            )
            assert res.status_code == 200, f"Expected 200 but got {res.status_code}: {res.text}"
            data = res.json()
            assert data["account"] == "smoke_user"
            assert data["status"] == "SESSION_OK"
    except Exception as e:
        if "Executable doesn't exist" in str(e) or "playwright install" in str(e):
            pytest.skip(f"Playwright browser binary not installed on host: {e}")
        else:
            raise

