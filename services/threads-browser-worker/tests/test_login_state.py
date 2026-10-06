"""Unit and contract tests for fail-closed login state evaluation and publishing auth guards."""

from unittest.mock import MagicMock, patch
import pytest
from app.browser import check_login_state
from app.errors import AuthRequiredError, AuthStateUnknownError
from app.publisher import publish_thread
import app.publisher as pub_mod


def _make_mock_page(url="https://www.threads.com/", visible_selectors=()):
    """Helper to create a mock Page whose locator().is_visible() returns True only for given selectors."""
    page = MagicMock()
    page.url = url

    def mock_locator(sel):
        loc = MagicMock()
        is_vis = any(v in sel or sel in v for v in visible_selectors)
        loc.first.is_visible.return_value = is_vis
        loc.count.return_value = 1 if is_vis else 0
        return loc

    page.locator.side_effect = mock_locator
    return page


def test_guest_modal_overrides_generic_nav():
    """Verify that guest modal ('Threadsでもっと発信しよう' / 'Instagramでログイン') returns AUTH_REQUIRED
    even if Home/Search/Profile icons are also visible."""
    # Simulate the real DOM: public home has Home/Search/Profile, but also guest login modal
    mock_page = _make_mock_page(
        url="https://www.threads.com/",
        visible_selectors=(
            '[role="dialog"]:has-text("Threadsでもっと発信しよう")',
            '[role="dialog"]:has-text("Instagramでログイン")',
            ':has-text("Threadsでもっと発信しよう")',
            ':has-text("Instagramでログイン")',
            'svg[aria-label="ホーム"]',
            'svg[aria-label="検索"]',
            'svg[aria-label="プロフィール"]',
        ),
    )

    state = check_login_state(mock_page)
    assert state == "AUTH_REQUIRED", f"Expected AUTH_REQUIRED but got {state}"


def test_generic_navigation_only_returns_unknown():
    """Verify that Home, Search, Profile icons ALONE return SESSION_UNKNOWN, not SESSION_OK."""
    mock_page = _make_mock_page(
        url="https://www.threads.com/",
        visible_selectors=(
            'svg[aria-label="ホーム"]',
            'svg[aria-label="検索"]',
            'svg[aria-label="プロフィール"]',
            'a[href*="/@"]',
        ),
    )

    state = check_login_state(mock_page)
    assert state == "SESSION_UNKNOWN", f"Expected SESSION_UNKNOWN but got {state}"


def test_strong_authenticated_indicator_returns_session_ok():
    """Verify that strong authenticated indicators (active composer trigger) return SESSION_OK."""
    mock_page = _make_mock_page(
        url="https://www.threads.com/",
        visible_selectors=(
            'div[role="button"]:has(svg[aria-label="新しいスレッド"])',
            'svg[aria-label="新しいスレッド"]',
        ),
    )

    state = check_login_state(mock_page)
    assert state == "SESSION_OK", f"Expected SESSION_OK but got {state}"


def test_login_redirect_returns_auth_required():
    """Verify that URL containing /login returns AUTH_REQUIRED."""
    mock_page = _make_mock_page(url="https://www.threads.com/login?show_choice_screen=false")
    state = check_login_state(mock_page)
    assert state == "AUTH_REQUIRED"


def test_publish_guard_auth_required_blocks_composer(monkeypatch, tmp_path):
    """Verify that if check_login_state returns AUTH_REQUIRED, publish_thread rejects immediately
    without touching composer buttons."""
    monkeypatch.setattr(pub_mod, "check_login_state", lambda page: "AUTH_REQUIRED")
    mock_open_composer = MagicMock()
    monkeypatch.setattr(pub_mod, "_find_and_open_composer", mock_open_composer)

    mock_pw = MagicMock()
    mock_ctx = MagicMock()
    mock_page = MagicMock()
    mock_page.url = "https://www.threads.com/"
    mock_ctx.pages = [mock_page]
    monkeypatch.setattr(pub_mod, "launch_persistent_browser", lambda acc: (mock_pw, mock_ctx))
    monkeypatch.setattr(pub_mod, "account_exists", lambda acc: True)

    with pytest.raises(AuthRequiredError):
        publish_thread("main", text="Test", dry_run=True)

    # Must NOT have attempted to open composer
    mock_open_composer.assert_not_called()


def test_publish_guard_session_unknown_blocks_composer(monkeypatch, tmp_path):
    """Verify that if check_login_state returns SESSION_UNKNOWN, publish_thread fails closed
    and raises AuthStateUnknownError without touching composer buttons."""
    monkeypatch.setattr(pub_mod, "check_login_state", lambda page: "SESSION_UNKNOWN")
    mock_open_composer = MagicMock()
    monkeypatch.setattr(pub_mod, "_find_and_open_composer", mock_open_composer)

    mock_pw = MagicMock()
    mock_ctx = MagicMock()
    mock_page = MagicMock()
    mock_page.url = "https://www.threads.com/"
    mock_ctx.pages = [mock_page]
    monkeypatch.setattr(pub_mod, "launch_persistent_browser", lambda acc: (mock_pw, mock_ctx))
    monkeypatch.setattr(pub_mod, "account_exists", lambda acc: True)

    with pytest.raises(AuthStateUnknownError):
        publish_thread("main", text="Test", dry_run=True)

    # Must NOT have attempted to open composer
    mock_open_composer.assert_not_called()


def test_desktop_authenticated_ui_returns_session_ok():
    """Verify that the actual desktop logged-in DOM layout returns SESSION_OK."""
    mock_page = _make_mock_page(
        url="https://www.threads.com/",
        visible_selectors=(
            'div:has-text("最近どう？"):has([role="button"]:has-text("投稿"))',
            'a[href*="/saved"]',
            'a[href*="/liked"]',
            'a[href*="/ghost"]',
            'a[href*="/archive"]',
            'nav [role="button"]:has-text("新しいスレッド")',
        ),
    )
    state = check_login_state(mock_page)
    assert state == "SESSION_OK", f"Expected SESSION_OK but got {state}"


@pytest.mark.parametrize(
    "indicator",
    [
        'a[href*="/saved"]',
        'a[href*="/liked"]',
        'a[href*="/ghost"]',
        'a[href*="/archive"]',
        'a[href*="/insights"]',
        'a[href*="/messages"]',
        'div[contenteditable="true"]:has-text("最近どう？")',
        '[placeholder*="最近どう？"]',
    ],
)
def test_individual_authenticated_indicators_return_session_ok(indicator):
    """Verify that each individual desktop authenticated selector returns SESSION_OK."""
    mock_page = _make_mock_page(
        url="https://www.threads.com/",
        visible_selectors=(indicator,),
    )
    state = check_login_state(mock_page)
    assert state == "SESSION_OK", f"Expected SESSION_OK for {indicator}, got {state}"


def test_find_and_open_composer_focuses_existing_inline_textbox():
    """Verify _find_and_open_composer clicks the inline composer textbox if already visible."""
    mock_page = MagicMock()
    mock_textbox = MagicMock()
    mock_textbox.is_visible.return_value = True

    # _find_composer_textbox will return mock_textbox when checking COMPOSER_TEXTBOX_SELECTORS
    def mock_locator(sel):
        loc = MagicMock()
        if 'div[contenteditable="true"]' in sel:
            loc.count.return_value = 1
            loc.first = mock_textbox
        else:
            loc.count.return_value = 0
        return loc

    mock_page.locator.side_effect = mock_locator
    mock_page.get_by_role.return_value.count.return_value = 0

    assert pub_mod._find_and_open_composer(mock_page) is True
    mock_textbox.click.assert_called_once()

