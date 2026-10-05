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
