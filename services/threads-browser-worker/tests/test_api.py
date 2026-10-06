from unittest.mock import patch, MagicMock
import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.config import settings
from app.accounts import get_account_profile_dir
from app.errors import (
    GhostNotAvailableError,
    GhostStateUnknownError,
    ComposerNotFoundError,
    AuthRequiredError,
)
from app.models import PostResponseModel

client = TestClient(app)
AUTH_HEADER = {"X-Threads-Service-Key": "test-secret-key-2026"}

@pytest.fixture(autouse=True)
def setup_service_key(monkeypatch):
    """Set default test service key so endpoints pass authentication unless specifically testing auth."""
    monkeypatch.setattr(settings, "SERVICE_KEY", "test-secret-key-2026")


def test_health_endpoint():
    res = client.get("/health")
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "ok"
    assert data["playwright"] is True


def test_service_key_fail_closed_when_not_configured(monkeypatch):
    monkeypatch.setattr(settings, "SERVICE_KEY", None)

    # /health still accessible without key
    res_health = client.get("/health")
    assert res_health.status_code == 200

    # /api/threads/accounts fails closed with 500 when SERVICE_KEY is not configured
    res_accounts = client.get("/api/threads/accounts")
    assert res_accounts.status_code == 500
    assert res_accounts.json()["detail"]["code"] == "SERVICE_KEY_NOT_CONFIGURED"

    # /api/threads/post fails closed with 500
    res_post = client.post("/api/threads/post", json={"account": "main", "text": "hello"})
    assert res_post.status_code == 500
    assert res_post.json()["detail"]["code"] == "SERVICE_KEY_NOT_CONFIGURED"


def test_service_key_authentication(monkeypatch):
    monkeypatch.setattr(settings, "SERVICE_KEY", "test-secret-key-2026")

    # Missing header -> 401
    res_no_key = client.get("/api/threads/accounts")
    assert res_no_key.status_code == 401
    assert res_no_key.json()["detail"]["code"] == "AUTH_REQUIRED"

    # Incorrect key -> 401
    res_wrong_key = client.get(
        "/api/threads/accounts",
        headers={"X-Threads-Service-Key": "wrong-key"},
    )
    assert res_wrong_key.status_code == 401

    # Valid key -> 200
    res_ok = client.get("/api/threads/accounts", headers=AUTH_HEADER)
    assert res_ok.status_code == 200
    assert "accounts" in res_ok.json()


def test_accounts_endpoint(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "SESSIONS_DIR", tmp_path)

    get_account_profile_dir("alpha_user", create=True)
    get_account_profile_dir("beta_user", create=True)

    res = client.get("/api/threads/accounts", headers=AUTH_HEADER)
    assert res.status_code == 200
    accounts = res.json()["accounts"]
    assert len(accounts) == 2
    names = [a["name"] for a in accounts]
    assert "alpha_user" in names
    assert "beta_user" in names


def test_session_check_unknown_account(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "SESSIONS_DIR", tmp_path)

    res = client.post("/api/threads/session/check", json={"account": "unknown_account"}, headers=AUTH_HEADER)
    assert res.status_code == 404
    data = res.json()
    assert data["code"] == "ACCOUNT_NOT_FOUND"


def test_session_check_success(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "SESSIONS_DIR", tmp_path)
    get_account_profile_dir("active_user", create=True)

    with patch("app.main.launch_persistent_browser") as mock_launch, \
         patch("app.main.check_login_state") as mock_check:
        mock_pw = MagicMock()
        mock_ctx = MagicMock()
        mock_launch.return_value = (mock_pw, mock_ctx)
        mock_check.return_value = "SESSION_OK"

        res = client.post("/api/threads/session/check", json={"account": "active_user"}, headers=AUTH_HEADER)
        assert res.status_code == 200
        data = res.json()
        assert data["account"] == "active_user"
        assert data["status"] == "SESSION_OK"


def test_post_unknown_account(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "SESSIONS_DIR", tmp_path)

    res = client.post(
        "/api/threads/post",
        json={"account": "ghost_account", "text": "Hello"},
        headers=AUTH_HEADER,
    )
    assert res.status_code == 404
    assert res.json()["code"] == "ACCOUNT_NOT_FOUND"


def test_post_validation_error(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "SESSIONS_DIR", tmp_path)

    # Empty text
    res = client.post(
        "/api/threads/post",
        json={"account": "main", "text": ""},
        headers=AUTH_HEADER,
    )
    assert res.status_code == 422
    assert res.json()["code"] == "VALIDATION_ERROR"

    # Traversal account
    res2 = client.post(
        "/api/threads/post",
        json={"account": "../evil", "text": "Valid text"},
        headers=AUTH_HEADER,
    )
    assert res2.status_code == 400
    assert res2.json()["code"] == "INVALID_ACCOUNT_NAME"


def test_post_dry_run_success(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "SESSIONS_DIR", tmp_path)
    get_account_profile_dir("main", create=True)

    with patch("app.main.publish_thread") as mock_publish:
        mock_publish.return_value = PostResponseModel(
            status="dry_run_ok",
            account="main",
            request_id="req-123",
        )

        res = client.post(
            "/api/threads/post",
            json={
                "account": "main",
                "text": "This is a dry run post",
                "dry_run": True,
                "request_id": "req-123",
            },
            headers=AUTH_HEADER,
        )
        assert res.status_code == 200
        data = res.json()
        assert data["status"] == "dry_run_ok"
        assert data["account"] == "main"
        assert data["request_id"] == "req-123"


def test_post_ghost_not_available(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "SESSIONS_DIR", tmp_path)
    get_account_profile_dir("main", create=True)

    with patch("app.main.publish_thread") as mock_publish:
        mock_publish.side_effect = GhostNotAvailableError()

        res = client.post(
            "/api/threads/post",
            json={
                "account": "main",
                "text": "Ghost test post",
                "is_ghost": True,
            },
            headers=AUTH_HEADER,
        )
        assert res.status_code == 409
        data = res.json()
        assert data["code"] == "GHOST_NOT_AVAILABLE"


def test_post_ghost_state_unknown(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "SESSIONS_DIR", tmp_path)
    get_account_profile_dir("main", create=True)

    with patch("app.main.publish_thread") as mock_publish:
        mock_publish.side_effect = GhostStateUnknownError()

        res = client.post(
            "/api/threads/post",
            json={
                "account": "main",
                "text": "Ghost test post",
                "is_ghost": True,
            },
            headers=AUTH_HEADER,
        )
        assert res.status_code == 409
        data = res.json()
        assert data["code"] == "GHOST_STATE_UNKNOWN"


def test_post_success_without_real_id_returns_submitted(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "SESSIONS_DIR", tmp_path)
    get_account_profile_dir("main", create=True)

    with patch("app.main.publish_thread") as mock_publish:
        mock_publish.return_value = PostResponseModel(
            status="submitted",
            account="main",
            post_id=None,
            url=None,
            request_id="req-sub-1",
        )

        res = client.post(
            "/api/threads/post",
            json={
                "account": "main",
                "text": "Post without UI permalink exposed",
            },
            headers=AUTH_HEADER,
        )
        assert res.status_code == 200
        data = res.json()
        assert data["status"] == "submitted"
        assert data["post_id"] is None
        assert data["url"] is None


def test_post_composer_not_found(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "SESSIONS_DIR", tmp_path)
    get_account_profile_dir("main", create=True)

    with patch("app.main.publish_thread") as mock_publish:
        mock_publish.side_effect = ComposerNotFoundError()

        res = client.post(
            "/api/threads/post",
            json={"account": "main", "text": "Sample text"},
            headers=AUTH_HEADER,
        )
        assert res.status_code == 502
        assert res.json()["code"] == "COMPOSER_NOT_FOUND"


def test_post_auth_required(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "SESSIONS_DIR", tmp_path)
    get_account_profile_dir("main", create=True)

    with patch("app.main.publish_thread") as mock_publish:
        mock_publish.side_effect = AuthRequiredError()

        res = client.post(
            "/api/threads/post",
            json={"account": "main", "text": "Sample text"},
            headers=AUTH_HEADER,
        )
        assert res.status_code == 401
        assert res.json()["code"] == "AUTH_REQUIRED"


def test_endpoints_playwright_sync_safety():
    """Verify that endpoints invoking Playwright Sync API are synchronous (def) functions, not coroutines (async def)."""
    import inspect
    from app.main import check_session, create_post
    assert not inspect.iscoroutinefunction(check_session), "check_session must be a synchronous def to run on threadpool"
    assert not inspect.iscoroutinefunction(create_post), "create_post must be a synchronous def to run on threadpool"


def test_session_check_executes_outside_asyncio_event_loop(tmp_path, monkeypatch):
    """Verify that when /api/threads/session/check is invoked through FastAPI routing,
    the handler execution thread has NO active asyncio event loop, allowing Playwright Sync API."""
    import asyncio
    monkeypatch.setattr(settings, "SESSIONS_DIR", tmp_path)
    get_account_profile_dir("main", create=True)

    verified_no_loop = False

    def spy_launch_persistent_browser(*args, **kwargs):
        nonlocal verified_no_loop
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None
        assert loop is None, "launch_persistent_browser was called inside an active asyncio event loop!"
        verified_no_loop = True
        mock_pw = MagicMock()
        mock_context = MagicMock()
        mock_context.pages = []
        return mock_pw, mock_context

    with patch("app.main.launch_persistent_browser", side_effect=spy_launch_persistent_browser), \
         patch("app.main.check_login_state", return_value="SESSION_OK"):
        res = client.post(
            "/api/threads/session/check",
            json={"account": "main"},
            headers=AUTH_HEADER,
        )
        assert res.status_code == 200
        assert res.json()["status"] == "SESSION_OK"
        assert verified_no_loop is True, "spy_launch_persistent_browser was not called"


def test_post_executes_outside_asyncio_event_loop(tmp_path, monkeypatch):
    """Verify that when /api/threads/post is invoked through FastAPI routing,
    the handler execution thread has NO active asyncio event loop, allowing Playwright Sync API."""
    import asyncio
    monkeypatch.setattr(settings, "SESSIONS_DIR", tmp_path)
    get_account_profile_dir("main", create=True)

    verified_no_loop = False

    def spy_publish_thread(*args, **kwargs):
        nonlocal verified_no_loop
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None
        assert loop is None, "publish_thread was called inside an active asyncio event loop!"
        verified_no_loop = True
        return PostResponseModel(status="dry_run_ok", account="main", post_id=None, url=None)

    with patch("app.main.publish_thread", side_effect=spy_publish_thread):
        res = client.post(
            "/api/threads/post",
            json={"account": "main", "text": "Testing threadpool execution", "dry_run": True},
            headers=AUTH_HEADER,
        )
        assert res.status_code == 200
        assert res.json()["status"] == "dry_run_ok"
        assert verified_no_loop is True, "spy_publish_thread was not called"


def test_get_account_profile_unknown_account(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "SESSIONS_DIR", tmp_path)
    res = client.get("/api/threads/accounts/non_existent/profile", headers=AUTH_HEADER)
    assert res.status_code == 404
    assert res.json()["code"] == "ACCOUNT_NOT_FOUND"


def test_get_account_profile_auth_required(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "SESSIONS_DIR", tmp_path)
    get_account_profile_dir("unauth_user", create=True)

    with patch("app.main.launch_persistent_browser") as mock_launch, \
         patch("app.main.check_login_state") as mock_check:
        mock_pw = MagicMock()
        mock_ctx = MagicMock()
        mock_launch.return_value = (mock_pw, mock_ctx)
        mock_check.return_value = "AUTH_REQUIRED"

        res = client.get("/api/threads/accounts/unauth_user/profile", headers=AUTH_HEADER)
        assert res.status_code == 200
        data = res.json()
        assert data["account"] == "unauth_user"
        assert data["status"] == "AUTH_REQUIRED"
        assert data["username"] is None
        assert data["profileUrl"] is None
        # Verify no credentials leaked
        assert "cookie" not in str(data).lower()
        assert "sessionid" not in str(data).lower()


def test_get_account_profile_session_ok(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "SESSIONS_DIR", tmp_path)
    get_account_profile_dir("main", create=True)

    with patch("app.main.launch_persistent_browser") as mock_launch, \
         patch("app.main.check_login_state") as mock_check, \
         patch("app.main.extract_profile_info") as mock_extract:
        mock_pw = MagicMock()
        mock_ctx = MagicMock()
        mock_launch.return_value = (mock_pw, mock_ctx)
        mock_check.return_value = "SESSION_OK"
        mock_extract.return_value = {
            "account": "main",
            "username": "threads_tester",
            "displayName": "Tester Account",
            "profileUrl": "https://www.threads.net/@threads_tester",
            "picture": "https://cdn.example.com/avatar.jpg",
        }

        res = client.get("/api/threads/accounts/main/profile", headers=AUTH_HEADER)
        assert res.status_code == 200
        data = res.json()
        assert data["account"] == "main"
        assert data["status"] == "SESSION_OK"
        assert data["username"] == "threads_tester"
        assert data["displayName"] == "Tester Account"
        assert data["profileUrl"] == "https://www.threads.net/@threads_tester"
        assert data["picture"] == "https://cdn.example.com/avatar.jpg"
        # Strict security: verify no secrets
        for forbidden in ["cookie", "sessionid", "csrftoken", "password", "token"]:
            assert forbidden not in data

