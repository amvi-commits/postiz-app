import os
import io
import tempfile
import pytest
from unittest.mock import MagicMock, patch
from pydantic import ValidationError
from fastapi.testclient import TestClient

from app.models import PostRequest, PostResponseModel
from app.errors import (
    MediaUploadFailedError,
    MediaTooLargeError,
    InvalidMediaError,
    GhostStateUnknownError,
    GhostNotAvailableError,
)
from app.publisher import (
    _validate_media_url_ssrf,
    _download_media_file_safe,
    _prepare_media_files,
    _attach_media_files,
    _wait_for_media_upload,
    _toggle_and_verify_ghost_mode,
    publish_thread,
)
from app.config import settings
from app.main import app

client = TestClient(app)
AUTH_HEADER = {"X-Threads-Service-Key": "test-key-media"}

@pytest.fixture(autouse=True)
def setup_service_key(monkeypatch):
    monkeypatch.setattr(settings, "SERVICE_KEY", "test-key-media")


def test_media_model_validation_success():
    req = PostRequest(
        account="main",
        text="Check out these photos!",
        media_urls=[
            "https://images.example.com/photo1.jpg",
            "https://images.example.com/photo2.PNG?query=param#frag",
            "https://images.example.com/photo3.webp",
        ],
        media_paths=["C:/local/photo4.jpeg"],
    )
    assert len(req.media_urls) == 3
    assert len(req.media_paths) == 1


def test_media_model_validation_unsupported_extension():
    # .gif is unsupported
    with pytest.raises(ValidationError) as exc:
        PostRequest(
            account="main",
            text="Hello",
            media_urls=["https://example.com/animation.gif"],
        )
    assert "Unsupported media format" in str(exc.value)

    # .mp4 is unsupported for image media sidecar
    with pytest.raises(ValidationError) as exc:
        PostRequest(
            account="main",
            text="Hello",
            media_paths=["video.mp4"],
        )
    assert "Unsupported media format" in str(exc.value)


def test_media_model_validation_max_limit_exceeded():
    urls = [f"https://example.com/p{i}.jpg" for i in range(11)]
    with pytest.raises(ValidationError) as exc:
        PostRequest(
            account="main",
            text="Hello",
            media_urls=urls,
        )
    assert "exceeds Threads maximum limit" in str(exc.value)


# --- SSRF Protection Tests ---

def test_ssrf_rejects_invalid_scheme():
    with pytest.raises(InvalidMediaError) as exc:
        _validate_media_url_ssrf("ftp://example.com/image.jpg")
    assert "無効なURLスキーム" in str(exc.value)


def test_ssrf_rejects_userinfo():
    with pytest.raises(InvalidMediaError) as exc:
        _validate_media_url_ssrf("http://admin:secret@example.com/image.jpg")
    assert "ユーザー名またはパスワード" in str(exc.value)


def test_ssrf_rejects_private_ips(monkeypatch):
    monkeypatch.setattr(settings, "MEDIA_ALLOWED_HOSTS", [])

    private_targets = [
        ("http://127.0.0.1/test.jpg", "127.0.0.1"),
        ("http://10.0.0.1/test.png", "10.0.0.1"),
        ("http://192.168.1.100/test.webp", "192.168.1.100"),
        ("http://172.16.0.5/test.jpeg", "172.16.0.5"),
        ("http://169.254.169.254/latest/meta-data/test.jpg", "169.254.169.254"),
    ]

    for url, ip in private_targets:
        with patch("socket.getaddrinfo", return_value=[(2, 1, 6, "", (ip, 80))]):
            with pytest.raises(InvalidMediaError) as exc:
                _validate_media_url_ssrf(url)
            assert "アクセスは禁止されています" in str(exc.value)


def test_ssrf_allows_whitelisted_host(monkeypatch):
    monkeypatch.setattr(settings, "MEDIA_ALLOWED_HOSTS", ["localhost", "127.0.0.1", "host.docker.internal"])

    # Should not raise because host is in allowlist
    _validate_media_url_ssrf("http://host.docker.internal:4017/uploads/image.jpg")
    _validate_media_url_ssrf("http://localhost:4017/uploads/image.jpg")


def test_ssrf_rejects_redirect_to_private_ip(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "MEDIA_ALLOWED_HOSTS", [])

    # Initial request to public host
    resp_redirect = MagicMock()
    resp_redirect.status_code = 302
    resp_redirect.headers = {"Location": "http://192.168.1.50/malicious.jpg"}

    # Mock socket getaddrinfo: public IP for first call, private for second call
    def mock_getaddrinfo(host, port, *args, **kwargs):
        if host == "public.example.com":
            return [(2, 1, 6, "", ("93.184.216.34", 80))]
        return [(2, 1, 6, "", ("192.168.1.50", 80))]

    with patch("socket.getaddrinfo", side_effect=mock_getaddrinfo):
        with patch("httpx.Client.stream") as mock_stream:
            mock_stream.return_value.__enter__.return_value = resp_redirect
            dest = str(tmp_path / "out.jpg")
            with pytest.raises(InvalidMediaError) as exc:
                _download_media_file_safe("http://public.example.com/initial.jpg", dest)
            assert "アクセスは禁止されています" in str(exc.value)


# --- Content-Type & Size Limit Tests ---

def test_media_rejects_invalid_content_type(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "MEDIA_ALLOWED_HOSTS", ["example.com"])

    resp = MagicMock()
    resp.status_code = 200
    resp.headers = {"Content-Type": "text/html"}

    with patch("socket.getaddrinfo", return_value=[(2, 1, 6, "", ("93.184.216.34", 80))]):
        with patch("httpx.Client.stream") as mock_stream:
            mock_stream.return_value.__enter__.return_value = resp
            dest = str(tmp_path / "out.jpg")
            with pytest.raises(InvalidMediaError) as exc:
                _download_media_file_safe("http://example.com/test.jpg", dest)
            assert "無効なContent-Type" in str(exc.value)


def test_media_rejects_oversized_file(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "MEDIA_ALLOWED_HOSTS", ["example.com"])
    monkeypatch.setattr(settings, "MEDIA_MAX_BYTES", 1024)  # 1KB limit

    resp = MagicMock()
    resp.status_code = 200
    resp.headers = {"Content-Type": "image/jpeg", "Content-Length": "2048"}
    resp.iter_bytes.return_value = [b"A" * 1500]

    with patch("socket.getaddrinfo", return_value=[(2, 1, 6, "", ("93.184.216.34", 80))]):
        with patch("httpx.Client.stream") as mock_stream:
            mock_stream.return_value.__enter__.return_value = resp
            dest = str(tmp_path / "out.jpg")
            with pytest.raises(MediaTooLargeError) as exc:
                _download_media_file_safe("http://example.com/large.jpg", dest)
            assert "メディアサイズが上限" in str(exc.value)


def test_prepare_media_files_sanitizes_log_output(tmp_path, caplog, monkeypatch):
    import logging
    caplog.set_level(logging.INFO)
    monkeypatch.setattr(settings, "MEDIA_ALLOWED_HOSTS", ["cdn.example.com"])

    fake_content = b"\xFF\xD8\xFF\xE0\x00\x10JFIF"
    with patch("app.publisher._download_media_file_safe") as mock_download:
        secret_url = "https://cdn.example.com/photo.jpg?token=SECRET_AUTH_TOKEN_XYZ&sig=12345"
        res = _prepare_media_files(
            media_urls=[secret_url],
            media_paths=None,
            temp_dir=str(tmp_path),
        )

        assert len(res) == 1
        # Assert that the full URL with secret query token is NOT in caplog
        assert "SECRET_AUTH_TOKEN_XYZ" not in caplog.text
        assert "host=cdn.example.com" in caplog.text


# --- Ghost Post Verification Tests ---

def test_ghost_toggle_not_available():
    mock_page = MagicMock()
    mock_loc = MagicMock()
    mock_loc.count.return_value = 0
    mock_page.get_by_label.return_value = mock_loc
    mock_page.locator.return_value = mock_loc

    with pytest.raises(GhostNotAvailableError) as exc:
        _toggle_and_verify_ghost_mode(mock_page)
    assert "操作UIが存在しない" in str(exc.value)


def test_ghost_toggle_and_verify_success():
    mock_page = MagicMock()
    mock_btn = MagicMock()
    mock_btn.count.return_value = 1
    mock_btn.first.is_visible.return_value = True
    # After click, it returns aria-checked="true"
    mock_btn.first.get_attribute.side_effect = lambda attr: "true" if attr == "aria-checked" else None

    mock_page.get_by_label.return_value = mock_btn

    assert _toggle_and_verify_ghost_mode(mock_page) is True
    mock_btn.first.click.assert_called_once()


def test_ghost_toggle_state_verification_failure():
    mock_page = MagicMock()
    mock_btn = MagicMock()
    mock_btn.count.return_value = 1
    mock_btn.first.is_visible.return_value = True
    # After click, it returns aria-checked="false"
    mock_btn.first.get_attribute.side_effect = lambda attr: "false"

    mock_page.get_by_label.return_value = mock_btn

    with pytest.raises(GhostStateUnknownError) as exc:
        _toggle_and_verify_ghost_mode(mock_page)
    assert "有効化状態を確認できませんでした" in str(exc.value)


# --- Publisher Dry-Run & API Post Tests ---

def test_publisher_media_dry_run_success(tmp_path, monkeypatch):
    import app.publisher as pub_mod

    monkeypatch.setattr(pub_mod, "account_exists", lambda acc: True)
    monkeypatch.setattr(pub_mod, "acquire_account_lock", MagicMock())

    mock_pw = MagicMock()
    mock_ctx = MagicMock()
    mock_page = MagicMock()
    mock_ctx.pages = [mock_page]

    monkeypatch.setattr(pub_mod, "launch_persistent_browser", lambda acc: (mock_pw, mock_ctx))
    monkeypatch.setattr(pub_mod, "check_login_state", lambda page: "SESSION_OK")
    monkeypatch.setattr(pub_mod, "_find_and_open_composer", lambda page: True)

    mock_textbox = MagicMock()
    monkeypatch.setattr(pub_mod, "_find_composer_textbox", lambda page: mock_textbox)
    monkeypatch.setattr(pub_mod, "_prepare_media_files", lambda urls, paths, d: ["/mock/file.jpg"])
    monkeypatch.setattr(pub_mod, "_attach_media_files", MagicMock())
    monkeypatch.setattr(pub_mod, "_wait_for_media_upload", MagicMock())

    result = pub_mod.publish_thread(
        account="valid_acc",
        text="Testing media dry run",
        media_urls=["https://example.com/photo.jpg"],
        dry_run=True,
        request_id="req_media_1",
    )

    assert result.status == "dry_run_ok"
    assert result.account == "valid_acc"
    assert result.request_id == "req_media_1"
    mock_textbox.fill.assert_called_once_with("Testing media dry run")


def test_api_post_with_media_success(monkeypatch):
    monkeypatch.setattr(
        "app.main.publish_thread",
        lambda **kwargs: PostResponseModel(
            status="ok",
            account=kwargs["account"],
            post_id="1802938472918234",
            url=f"https://www.threads.net/@{kwargs['account']}/post/1802938472918234",
            request_id=kwargs.get("request_id"),
        ),
    )

    response = client.post(
        "/api/threads/post",
        json={
            "account": "main",
            "text": "Post with media URLs",
            "media_urls": ["https://cdn.example.com/pic1.jpg", "https://cdn.example.com/pic2.png"],
        },
        headers=AUTH_HEADER,
    )

    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert data["post_id"] == "1802938472918234"


def test_api_post_with_invalid_media_extension():
    response = client.post(
        "/api/threads/post",
        json={
            "account": "main",
            "text": "Post with bad media",
            "media_urls": ["https://cdn.example.com/bad.bmp"],
        },
        headers=AUTH_HEADER,
    )
    assert response.status_code == 422
    assert "Unsupported media format" in response.json()["message"]
