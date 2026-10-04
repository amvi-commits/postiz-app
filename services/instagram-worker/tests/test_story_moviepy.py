"""Small offline checks for the standard MoviePy Story overlay path."""

from pathlib import Path

from fastapi.testclient import TestClient
from moviepy import TextClip
import pytest

from app.crypto_store import CredentialStore
from app.main import create_app
from app.schemas import StickerPosition
from app.story_visual import StoryVisualInputError, render_story_link_video, story_link_text
from test_worker import FakeClient, copy_test_story_video


def test_default_font_displays_the_two_ascii_lines():
    clip = TextClip(font=None, text=story_link_text("https://example.com/path?a=1"),
                    method="caption", size=(551, 499), color="white", bg_color="black",
                    text_align="center", horizontal_align="center", vertical_align="center")
    try:
        assert clip.text == "OPEN LINK\nexample.com"
        assert clip.size == (551, 499)
        frame = clip.get_frame(0)
        assert (frame == 255).all(axis=2).any()
        assert (frame == 0).all(axis=2).any()
    finally:
        clip.close()


def test_invalid_url_rotation_and_bounds_stop_before_opening_media(tmp_path):
    for url in ("not-a-url", "https:///", "javascript:alert(1)"):
        with pytest.raises(StoryVisualInputError) as error:
            story_link_text(url)
        assert error.value.code == "IG_STORY_LINK_INVALID"
    for sticker, code in ((StickerPosition(rotation=10), "IG_STORY_ROTATION_UNSUPPORTED"),
                          (StickerPosition(x=0), "IG_STORY_STICKER_POSITION_INVALID")):
        with pytest.raises(StoryVisualInputError) as error:
            render_story_link_video(tmp_path / "missing.mp4", tmp_path / "out.mp4",
                                    "https://example.com/", sticker)
        assert error.value.code == code


def test_visual_preflight_renders_and_cleans_without_account_or_instagram_client(tmp_path):
    store = CredentialStore(tmp_path / "secure")
    source = tmp_path / "story.mp4"
    source.write_bytes(b"offline-source")
    outputs = []

    def renderer(video, output, url, sticker):
        outputs.append(output)
        assert video == source.resolve()
        assert output.parent != source.parent
        assert sticker.model_dump() == StickerPosition().model_dump()
        return copy_test_story_video(video, output, url, sticker)

    def forbidden_client():
        pytest.fail("Visual preflight must never create an Instagram client")

    app = create_app(store=store, client_factory=forbidden_client, media_root=tmp_path,
                     story_visual_renderer=renderer)
    client = TestClient(app, headers={"Authorization": f"Bearer {app.state.token}"})
    body = {"accountId": "no-session-needed", "mediaPath": str(source), "mediaType": "video",
            "linkUrl": "https://example.com/path?a=1", "sticker": StickerPosition().model_dump()}
    result = client.post("/media/preflight/story", json=body)
    assert result.status_code == 200
    assert result.json()["ready"] is True
    assert result.json()["visual"]["text"] == "OPEN LINK\nexample.com"
    assert result.json()["link"]["webUri"] == body["linkUrl"]
    assert len(outputs) == 1 and not outputs[0].parent.exists()
    assert source.read_bytes() == b"offline-source"
    body["linkUrl"] = "not-a-url"
    assert client.post("/media/preflight/story", json=body).status_code == 422
    assert len(outputs) == 1


def test_render_failure_stops_upload_once_and_cleans_temp(tmp_path):
    store = CredentialStore(tmp_path / "secure")
    store.save("account-1", {"session": {"offline": True}, "username": "unit-account"})
    source = tmp_path / "story.mp4"
    source.write_bytes(b"offline-source")
    attempts = []

    def failing_renderer(video, output, url, sticker):
        attempts.append(output)
        output.write_bytes(b"partial-render")
        raise RuntimeError("MoviePy render failed")

    class NoUploadClient(FakeClient):
        def video_upload_to_story(self, *_args, **_kwargs):
            pytest.fail("Instagram upload must not run after a render failure")

    app = create_app(store=store, client_factory=NoUploadClient, media_root=tmp_path,
                     story_visual_renderer=failing_renderer)
    client = TestClient(app, headers={"Authorization": f"Bearer {app.state.token}"})
    body = {"accountId": "account-1", "mediaPath": str(source), "mediaType": "video",
            "linkUrl": "https://example.com/", "sticker": StickerPosition().model_dump()}
    response = client.post("/publish/story", json=body)  # In-process mock only, network=none.
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "IG_STORY_VISUAL_RENDER_FAILED"
    assert len(attempts) == 1
    assert not attempts[0].parent.exists()
    assert source.read_bytes() == b"offline-source"
