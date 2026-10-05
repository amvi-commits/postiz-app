from unittest.mock import patch, MagicMock
import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.config import settings
from app.accounts import get_account_profile_dir
from app.errors import GhostNotAvailableError, ComposerNotFoundError, AuthRequiredError
from app.models import PostResponseModel

client = TestClient(app)

def test_health_endpoint():
    res = client.get("/health")
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "ok"
    assert data["playwright"] is True

def test_service_key_authentication(monkeypatch):
    monkeypatch.setattr(settings, "SERVICE_KEY", "secret-test-key-2026")

    # /health still accessible without key
    res_health = client.get("/health")
    assert res_health.status_code == 200

    # /api/threads/accounts without header -> 401
    res_no_key = client.get("/api/threads/accounts")
    assert res_no_key.status_code == 401
    assert res_no_key.json()["detail"]["code"] == "AUTH_REQUIRED"

    # /api/threads/accounts with incorrect key -> 401
    res_wrong_key = client.get(
        "/api/threads/accounts",
        headers={"X-Threads-Service-Key": "wrong-key"},
    )
    assert res_wrong_key.status_code == 401

    # /api/threads/accounts with valid key -> 200
    res_ok = client.get(
        "/api/threads/accounts",
        headers={"X-Threads-Service-Key": "secret-test-key-2026"},
    )
    assert res_ok.status_code == 200
    assert "accounts" in res_ok.json()

def test_accounts_endpoint(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "SESSIONS_DIR", tmp_path)
    monkeypatch.setattr(settings, "SERVICE_KEY", None)

    get_account_profile_dir("alpha_user", create=True)
    get_account_profile_dir("beta_user", create=True)

    res = client.get("/api/threads/accounts")
    assert res.status_code == 200
    accounts = res.json()["accounts"]
    assert len(accounts) == 2
    names = [a["name"] for a in accounts]
    assert "alpha_user" in names
    assert "beta_user" in names

def test_session_check_unknown_account(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "SESSIONS_DIR", tmp_path)
    monkeypatch.setattr(settings, "SERVICE_KEY", None)

    res = client.post("/api/threads/session/check", json={"account": "unknown_account"})
    assert res.status_code == 404
    data = res.json()
    assert data["code"] == "ACCOUNT_NOT_FOUND"

def test_session_check_success(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "SESSIONS_DIR", tmp_path)
    monkeypatch.setattr(settings, "SERVICE_KEY", None)
    get_account_profile_dir("active_user", create=True)

    with patch("app.main.launch_persistent_browser") as mock_launch, \
         patch("app.main.check_login_state") as mock_check:
        mock_pw = MagicMock()
        mock_ctx = MagicMock()
        mock_launch.return_value = (mock_pw, mock_ctx)
        mock_check.return_value = "SESSION_OK"

        res = client.post("/api/threads/session/check", json={"account": "active_user"})
        assert res.status_code == 200
        data = res.json()
        assert data["account"] == "active_user"
        assert data["status"] == "SESSION_OK"

def test_post_unknown_account(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "SESSIONS_DIR", tmp_path)
    monkeypatch.setattr(settings, "SERVICE_KEY", None)

    res = client.post(
        "/api/threads/post",
        json={"account": "ghost_account", "text": "Hello"},
    )
    assert res.status_code == 404
    assert res.json()["code"] == "ACCOUNT_NOT_FOUND"

def test_post_validation_error(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "SESSIONS_DIR", tmp_path)
    monkeypatch.setattr(settings, "SERVICE_KEY", None)

    # Empty text
    res = client.post(
        "/api/threads/post",
        json={"account": "main", "text": ""},
    )
    assert res.status_code == 422
    assert res.json()["code"] == "VALIDATION_ERROR"

    # Traversal account
    res2 = client.post(
        "/api/threads/post",
        json={"account": "../evil", "text": "Valid text"},
    )
    assert res2.status_code == 400
    assert res2.json()["code"] == "INVALID_ACCOUNT_NAME"

def test_post_dry_run_success(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "SESSIONS_DIR", tmp_path)
    monkeypatch.setattr(settings, "SERVICE_KEY", None)
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
        )
        assert res.status_code == 200
        data = res.json()
        assert data["status"] == "dry_run_ok"
        assert data["account"] == "main"
        assert data["request_id"] == "req-123"

def test_post_ghost_not_available(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "SESSIONS_DIR", tmp_path)
    monkeypatch.setattr(settings, "SERVICE_KEY", None)
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
        )
        assert res.status_code == 409
        data = res.json()
        assert data["code"] == "GHOST_NOT_AVAILABLE"

def test_post_composer_not_found(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "SESSIONS_DIR", tmp_path)
    monkeypatch.setattr(settings, "SERVICE_KEY", None)
    get_account_profile_dir("main", create=True)

    with patch("app.main.publish_thread") as mock_publish:
        mock_publish.side_effect = ComposerNotFoundError()

        res = client.post(
            "/api/threads/post",
            json={"account": "main", "text": "Sample text"},
        )
        assert res.status_code == 502
        assert res.json()["code"] == "COMPOSER_NOT_FOUND"

def test_post_auth_required(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "SESSIONS_DIR", tmp_path)
    monkeypatch.setattr(settings, "SERVICE_KEY", None)
    get_account_profile_dir("main", create=True)

    with patch("app.main.publish_thread") as mock_publish:
        mock_publish.side_effect = AuthRequiredError()

        res = client.post(
            "/api/threads/post",
            json={"account": "main", "text": "Sample text"},
        )
        assert res.status_code == 401
        assert res.json()["code"] == "AUTH_REQUIRED"
