import os
import tempfile
import pytest
from unittest.mock import MagicMock, patch
from pydantic import ValidationError
from fastapi.testclient import TestClient

from app.models import PostRequest, PostResponseModel
from app.errors import MediaUploadFailedError, InvalidMediaError
from app.publisher import _prepare_media_files, _attach_media_files, _wait_for_media_upload, publish_thread
from app.main import app

client = TestClient(app)

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


def test_prepare_media_files_download_success(tmp_path):
    fake_content = b"\xFF\xD8\xFF\xE0\x00\x10JFIF"  # Minimal JPEG header
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.content = fake_content

    with patch("httpx.Client.get", return_value=mock_resp):
        res = _prepare_media_files(
            media_urls=["https://example.com/test_image.jpg"],
            media_paths=None,
            temp_dir=str(tmp_path),
        )

    assert len(res) == 1
    assert os.path.exists(res[0])
    with open(res[0], "rb") as f:
        assert f.read() == fake_content


def test_prepare_media_files_download_http_error(tmp_path):
    mock_resp = MagicMock()
    mock_resp.status_code = 404

    with patch("httpx.Client.get", return_value=mock_resp):
        with pytest.raises(MediaUploadFailedError) as exc:
            _prepare_media_files(
                media_urls=["https://example.com/not_found.png"],
                media_paths=None,
                temp_dir=str(tmp_path),
            )
    assert "HTTP 404" in str(exc.value)


def test_prepare_media_files_missing_local_file(tmp_path):
    with pytest.raises(InvalidMediaError) as exc:
        _prepare_media_files(
            media_urls=None,
            media_paths=[str(tmp_path / "non_existent_file.png")],
            temp_dir=str(tmp_path),
        )
    assert "存在しません" in str(exc.value)


def test_attach_media_files_via_input(tmp_path):
    mock_page = MagicMock()
    mock_input = MagicMock()
    mock_input.count.return_value = 1
    mock_page.locator.return_value = mock_input

    sample_file = tmp_path / "img.jpg"
    sample_file.write_text("dummy")

    _attach_media_files(mock_page, [str(sample_file)])
    mock_input.first.set_input_files.assert_called_once_with([str(sample_file)])


def test_wait_for_media_upload_success():
    mock_page = MagicMock()
    mock_progress = MagicMock()
    mock_progress.count.return_value = 0
    mock_preview = MagicMock()
    mock_preview.count.return_value = 1
    mock_preview.first.is_visible.return_value = True

    def locator_side_effect(selector):
        if "progressbar" in selector or "Loading" in selector:
            return mock_progress
        return mock_preview

    mock_page.locator.side_effect = locator_side_effect

    # Should not raise
    _wait_for_media_upload(mock_page, timeout_sec=2.0)


def test_wait_for_media_upload_timeout():
    mock_page = MagicMock()
    mock_loc = MagicMock()
    mock_loc.count.return_value = 0
    mock_page.locator.return_value = mock_loc

    with pytest.raises(MediaUploadFailedError) as exc:
        _wait_for_media_upload(mock_page, timeout_sec=0.5)
    assert "タイムアウト" in str(exc.value)


def test_publisher_media_dry_run_success(tmp_path, monkeypatch):
    import app.publisher as pub_mod

    # Setup temporary account
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
            post_id="th_sidecar_media_99",
            url=f"https://www.threads.net/@{kwargs['account']}",
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
    )

    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert data["post_id"] == "th_sidecar_media_99"


def test_api_post_with_invalid_media_extension():
    response = client.post(
        "/api/threads/post",
        json={
            "account": "main",
            "text": "Post with bad media",
            "media_urls": ["https://cdn.example.com/bad.bmp"],
        },
    )
    assert response.status_code == 422
    assert "Unsupported media format" in response.json()["message"]
