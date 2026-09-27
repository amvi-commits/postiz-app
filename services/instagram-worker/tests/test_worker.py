from pathlib import Path

from fastapi.testclient import TestClient

from app.crypto_store import CredentialStore
from app.main import create_app


class FakeMedia:
    pk = "media-1"
    code = "abc123"


class FakeClient:
    def __init__(self):
        self.settings = {}
        self.logged_in = False

    def set_proxy(self, proxy):
        self.proxy = proxy

    def set_settings(self, settings):
        self.settings = settings

    def login(self, username, password, **kwargs):
        self.logged_in = True
        self.settings = {"username": username, "device": "stable-device"}
        return True

    def get_settings(self):
        return self.settings

    def account_info(self):
        return {"username": "test_account", "pk": "123", "follower_count": 10}

    def clip_trial_eligible(self):
        return True

    def clip_upload(self, path, caption, **kwargs):
        return FakeMedia()

    def photo_upload_to_story(self, path, **kwargs):
        return FakeMedia()

    def video_upload_to_story(self, path, **kwargs):
        return FakeMedia()

    def media_info(self, media_id):
        return {"pk": media_id, "metrics": {"views": 20}}


def make_client(tmp_path: Path):
    store = CredentialStore(tmp_path / "secure")
    # Use a separate store instance to exercise on-disk encryption and reload.
    app = create_app(store=store, client_factory=FakeClient, media_root=tmp_path / "uploads")
    (tmp_path / "uploads").mkdir(exist_ok=True)
    (tmp_path / "uploads" / "reel.mp4").write_bytes(b"mock video")
    headers = {"Authorization": f"Bearer {app.state.token}"} if app.state.token else {}
    return TestClient(app, headers=headers), store, tmp_path / "uploads" / "reel.mp4"


def test_health_and_login_do_not_return_secrets(tmp_path):
    client, store, _ = make_client(tmp_path)
    assert client.get("/health").json()["status"] == "ok"
    assert client.post(
        "/accounts/login",
        json={"accountId": "account-unauthorized", "username": "u", "password": "p"},
        headers={"Authorization": "Bearer wrong-token"},
    ).status_code == 401

    response = client.post(
        "/accounts/login",
        json={"accountId": "account-1", "username": "test_account", "password": "secret"},
    )
    assert response.status_code == 200
    assert "password" not in response.text
    assert "session" not in response.text
    assert store.load("account-1")["password"] == "secret"
    assert b"secret" not in (store.data_dir / "account-1.enc").read_bytes()


def test_trial_eligibility_and_reel_publish(tmp_path):
    client, _, reel = make_client(tmp_path)
    client.post("/accounts/login", json={"accountId": "account-1", "username": "u", "password": "p"})
    assert client.get("/accounts/account-1/trial-reel-eligibility").json()["eligible"] is True
    response = client.post(
        "/publish/reel",
        json={"accountId": "account-1", "videoPath": str(reel), "caption": "hello", "trialReel": True},
    )
    assert response.status_code == 200
    assert response.json()["mediaType"] == "TRIAL_REEL"


def test_media_paths_cannot_escape_shared_upload_root(tmp_path):
    client, _, _ = make_client(tmp_path)
    client.post("/accounts/login", json={"accountId": "account-1", "username": "u", "password": "p"})
    response = client.post(
        "/publish/reel",
        json={"accountId": "account-1", "videoPath": str(tmp_path / "outside.mp4"), "caption": ""},
    )
    assert response.status_code == 400


def test_story_sticker_is_validated(tmp_path):
    client, _, reel = make_client(tmp_path)
    client.post("/accounts/login", json={"accountId": "account-1", "username": "u", "password": "p"})
    response = client.post(
        "/publish/story",
        json={
            "accountId": "account-1",
            "mediaPath": str(reel),
            "mediaType": "image",
            "linkUrl": "https://example.com/item",
            "sticker": {"x": 1.5, "y": 0.5, "width": 0.4, "height": 0.2, "rotation": 0},
        },
    )
    assert response.status_code == 422


def test_story_publish_accepts_valid_sticker_and_returns_mock_result(tmp_path):
    client, _, story = make_client(tmp_path)
    assert client.post("/accounts/login", json={"accountId": "account-1", "username": "u", "password": "p"}).status_code == 200
    response = client.post(
        "/publish/story",
        json={
            "accountId": "account-1",
            "mediaPath": str(story),
            "mediaType": "image",
            "linkUrl": "https://example.com/item",
            "sticker": {"x": 0.5, "y": 0.5, "width": 0.4, "height": 0.2, "rotation": 0},
        },
    )
    assert response.status_code == 200
    assert response.json()["mediaType"] == "STORY"


def test_local_mock_reel_story_health_and_insights_are_credential_free(tmp_path, monkeypatch):
    from app.main import _MockInstagramClient

    monkeypatch.setenv("SNS_STUDIO_INSTAGRAM_MOCK", "true")
    store = CredentialStore(tmp_path / "secure")
    upload_root = tmp_path / "uploads"
    upload_root.mkdir(exist_ok=True)
    media = upload_root / "reel.mp4"
    media.write_bytes(b"local mock video")
    app = create_app(store=store, media_root=upload_root)
    headers = {"Authorization": f"Bearer {app.state.token}"} if app.state.token else {}
    client = TestClient(app, headers=headers)

    assert isinstance(app.state.client_factory(), _MockInstagramClient)
    for account_id, username in (("mock-a", "demo_a"), ("mock-b", "demo_b")):
        response = client.post("/accounts/login", json={"accountId": account_id, "username": username, "password": "local-only"})
        assert response.status_code == 200
        assert client.get(f"/accounts/{account_id}/health").json()["status"] == "GREEN"

    first_reel = client.post("/publish/reel", json={"accountId": "mock-a", "videoPath": str(media), "caption": "Local mock"})
    assert first_reel.status_code == 200
    assert first_reel.json()["mediaType"] == "REEL"
    story = client.post(
        "/publish/story",
        json={
            "accountId": "mock-b",
            "mediaPath": str(media),
            "mediaType": "video",
            "linkUrl": "https://example.com/mock",
            "sticker": {"x": 0.5, "y": 0.5, "width": 0.4, "height": 0.2, "rotation": 0},
        },
    )
    assert story.status_code == 200
    assert story.json()["mediaType"] == "STORY"
    insights = client.get(f"/insights/media/{first_reel.json()['mediaId']}?accountId=mock-a")
    assert insights.status_code == 200
    assert insights.json()["metrics"]["views"] == 42
    assert store.load("mock-a")["username"] == "demo_a"
    assert store.load("mock-b")["username"] == "demo_b"
