"""Inspect the installed instagrapi serializers with all network transport blocked."""

import json
from pathlib import Path
import socket

import pytest
import requests
from instagrapi import Client
from instagrapi.types import StoryLink, StorySticker, StoryStickerLink

URL = "https://example.com/"
PLACEMENT = dict(x=0.5, y=0.5, width=0.51, height=0.26, rotation=0)


@pytest.fixture(autouse=True)
def block_network(monkeypatch):
    def denied(*_args, **_kwargs):
        raise AssertionError("Instagram/network transport is forbidden in serialization tests")
    monkeypatch.setattr(socket.socket, "connect", denied)
    monkeypatch.setattr(socket.socket, "connect_ex", denied)
    monkeypatch.setattr(socket, "create_connection", denied)
    monkeypatch.setattr(requests.sessions.Session, "request", denied)


def configure(kind, **kwargs):
    client = Client()
    calls = []
    # Avoid even synthetic device/session fields in the captured evidence.
    client.with_default_data = lambda data: data

    def capture(endpoint, data):
        calls.append((endpoint, data))
        return data

    client.private_request = capture
    if kind == "video":
        client.video_configure_to_story("offline-id", 1080, 1920, 3.675,
                                        Path("/tmp/offline.jpg"), "", **kwargs)
    else:
        client.photo_configure_to_story("offline-id", 1080, 1920, "", **kwargs)
    return calls


def link_fields(payload):
    keys = ("tap_models", "static_models", "story_sticker_ids", "sticker_ids",
            "story_link_stickers", "story_cta", "stickers", "link_title", "display_url")
    result = {k: payload[k] for k in keys if k in payload}
    for key in ("tap_models", "static_models", "story_link_stickers", "story_cta"):
        if isinstance(result.get(key), str):
            result[key] = json.loads(result[key])
    return result


@pytest.mark.parametrize("kind", ["video", "photo"])
def test_current_story_link_contains_tap_metadata_without_visual_asset(kind):
    calls = configure(kind, links=[StoryLink(webUri=URL, **PLACEMENT)])
    assert calls[0][0] == "media/validate_reel_url/"
    assert calls[0][1]["url"] == URL
    fields = link_fields(calls[-1][1])
    assert set(fields) == {"tap_models", "story_sticker_ids"}
    assert fields["story_sticker_ids"] == "link_sticker_default"
    assert fields["tap_models"] == [{
        **PLACEMENT, "z": 0, "type": "story_link", "is_sticker": True,
        "selected_index": 0, "tap_state": 0, "link_type": "web", "url": URL,
        "tap_state_str_id": "link_sticker_default",
    }]
    assert "asset_id" not in fields["tap_models"][0]


@pytest.mark.parametrize("kind", ["video", "photo"])
def test_story_sticker_nested_link_is_valid_model_but_ignored_by_configure(kind):
    nested = StoryStickerLink(url=URL, link_title="Open link", display_url="example.com", link_type="web")
    sticker = StorySticker(type="story_link", z=0, story_link=nested, **PLACEMENT)
    assert sticker.model_dump(mode="json")["story_link"] == {
        "url": URL, "link_title": "Open link", "display_url": "example.com", "link_type": "web",
    }
    calls = configure(kind, stickers=[sticker])
    assert len(calls) == 1  # This route does not even validate the nested URL.
    tap = link_fields(calls[-1][1])["tap_models"][0]
    for key in ("story_link", "url", "link_title", "display_url", "link_type", "str_id", "asset_id"):
        assert key not in tap
    assert tap == {**PLACEMENT, "z": 0, "type": "story_link", "is_sticker": True,
                   "selected_index": 0, "tap_state": 0}


@pytest.mark.parametrize("kind", ["video", "photo"])
def test_explicit_extra_and_id_only_extend_metadata_not_a_visual_render(kind):
    nested = StoryStickerLink(url=URL, link_title="Open link", display_url="example.com", link_type="web")
    extra = {**nested.model_dump(mode="json"), "tap_state_str_id": "link_sticker_default"}
    sticker = StorySticker(id="link_sticker_default", type="story_link", z=0,
                           story_link=nested, extra=extra, **PLACEMENT)
    fields = link_fields(configure(kind, stickers=[sticker])[-1][1])
    assert fields["story_sticker_ids"] == "link_sticker_default"
    tap = fields["tap_models"][0]
    assert tap["str_id"] == "link_sticker_default"
    for key, value in extra.items():
        assert tap[key] == value
    assert "story_link_stickers" not in fields
    assert "static_models" not in fields
    assert "asset_id" not in tap


@pytest.mark.parametrize("kind", ["video", "photo"])
def test_extra_data_can_pass_arbitrary_fields_without_proving_server_support(kind):
    nested = StoryStickerLink(url=URL, link_title="Open link", display_url="example.com", link_type="web")
    extra_data = {"story_link_stickers": json.dumps([nested.model_dump(mode="json")]),
                  "story_cta": "[]", "offline_marker": "not-a-supported-native-contract"}
    payload = configure(kind, extra_data=extra_data)[-1][1]
    assert payload["story_link_stickers"] == extra_data["story_link_stickers"]
    assert payload["offline_marker"] == extra_data["offline_marker"]
    assert "tap_models" not in payload


@pytest.mark.parametrize("kind", ["video", "photo"])
def test_upload_forwards_stickers_and_links_to_configure_offline(kind, monkeypatch):
    client = Client()
    calls = []
    link = StoryLink(webUri=URL, **PLACEMENT)
    sticker = StorySticker(type="story_link", z=0,
                           story_link=StoryStickerLink(url=URL), **PLACEMENT)
    monkeypatch.setattr("time.sleep", lambda *_args: None)
    monkeypatch.setattr(client, "_current_story_ids", lambda: set())
    monkeypatch.setattr(client, "_extract_configured_story_or_recent", lambda *_args: "offline-result")

    def capture(*args, **kwargs):
        calls.append((args, kwargs))
        return {"status": "ok"}

    if kind == "video":
        monkeypatch.setattr(client, "video_rupload", lambda *_args, **_kwargs: ("offline-id", 1080, 1920, 3.675, Path("/tmp/offline.jpg")))
        monkeypatch.setattr(client, "video_configure_to_story", capture)
        result = client.video_upload_to_story(Path("offline.mp4"), links=[link], stickers=[sticker])
        assert calls[0][0][8] == [link]
        assert calls[0][0][10] == [sticker]
    else:
        monkeypatch.setattr(client, "photo_rupload", lambda *_args, **_kwargs: ("offline-id", 1080, 1920))
        monkeypatch.setattr(client, "photo_configure_to_story", capture)
        result = client.photo_upload_to_story(Path("offline.jpg"), links=[link], stickers=[sticker])
        assert calls[0][0][6] == [link]
        assert calls[0][0][8] == [sticker]
    assert result == "offline-result"
    assert len(calls) == 1
