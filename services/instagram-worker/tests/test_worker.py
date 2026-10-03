import json
import logging
from pathlib import Path

from fastapi.testclient import TestClient

from app.crypto_store import CredentialStore
from app.main import _error_code, create_app


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


def test_missing_video_thumbnail_dependency_has_specific_error_code():
    error = RuntimeError(
        "Could not generate video thumbnail. Pass thumbnail=... or install MoviePy 2.2.1."
    )
    assert _error_code(error) == (
        "IG_MEDIA_PROCESSING_FAILED",
        "The Reel video could not be prepared for upload.",
        422,
    )


def make_client(tmp_path: Path):
    store = CredentialStore(tmp_path / "secure")
    def write_test_thumbnail(_video_path: Path, thumbnail_path: Path):
        thumbnail_path.write_bytes(b"test-thumbnail")

    # Use a separate store instance to exercise on-disk encryption and reload.
    app = create_app(
        store=store,
        client_factory=FakeClient,
        media_root=tmp_path / "uploads",
        thumbnail_generator=write_test_thumbnail,
    )
    (tmp_path / "uploads").mkdir(exist_ok=True)
    (tmp_path / "uploads" / "reel.mp4").write_bytes(b"mock video")
    headers = {"Authorization": f"Bearer {app.state.token}"} if app.state.token else {}
    return TestClient(app, headers=headers), store, tmp_path / "uploads" / "reel.mp4"


def test_health_and_login_do_not_return_secrets(tmp_path, monkeypatch):
    monkeypatch.setenv("SNS_STUDIO_SERVICE_TOKEN", "test-service-token")
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
    assert response.json()["sessionStatus"] == "VALID"
    assert "session" not in response.json()
    assert "cookies" not in response.json()
    assert store.load("account-1")["password"] == "secret"
    assert b"secret" not in (store.data_dir / "account-1.enc").read_bytes()


def test_login_route_saves_session_and_health_moves_to_valid(tmp_path, caplog):
    caplog.set_level(logging.INFO, logger="sns-instagram-worker")
    client, store, _ = make_client(tmp_path)
    initial = client.get("/accounts/account-1/health")
    assert initial.status_code == 200
    assert initial.json()["loginState"] == "LOGIN_REQUIRED"

    response = client.post(
        "/accounts/login",
        json={
            "accountId": "account-1",
            "username": "test_account",
            "password": "private-password",
            "proxy": "http://proxy-secret@proxy.example:8080",
        },
    )
    assert response.status_code == 200
    assert response.json()["sessionStatus"] == "VALID"
    assert store.load("account-1")["status"] == "ACTIVE"
    assert client.get("/accounts/account-1/health").json()["status"] == "GREEN"
    assert "LOGIN_REQUEST_RECEIVED accountId=account-1" in caplog.text
    assert "LOGIN_ATTEMPT usernameMasked=te***t" in caplog.text
    assert "LOGIN_SUCCESS accountId=account-1" in caplog.text
    assert "SESSION_SAVED accountId=account-1" in caplog.text
    assert "private-password" not in caplog.text
    assert "proxy-secret" not in caplog.text


def test_bad_password_is_reported_without_secrets(tmp_path, caplog):
    class BadPasswordError(Exception):
        pass

    class BadPasswordClient(FakeClient):
        def login(self, username, password, **kwargs):
            raise BadPasswordError("private-password")

    store = CredentialStore(tmp_path / "secure")
    app = create_app(store=store, client_factory=BadPasswordClient)
    client = TestClient(app, headers={"Authorization": f"Bearer {app.state.token}"})
    response = client.post(
        "/accounts/login",
        json={"accountId": "account-bad-pass", "username": "private-user", "password": "private-password"},
    )
    assert response.status_code == 401
    assert response.json()["detail"]["errorCode"] == "IG_BAD_PASSWORD"
    assert response.json()["detail"]["requiresAction"] is False
    assert "LOGIN_BAD_PASSWORD accountId=account-bad-pass" in caplog.text
    assert "private-password" not in caplog.text
    assert "private-user" not in caplog.text


def test_two_factor_login_can_continue_and_save_session(tmp_path, caplog):
    class TwoFactorRequiredError(Exception):
        pass

    class TwoFactorClient(FakeClient):
        def login(self, username, password, **kwargs):
            if not kwargs.get("verification_code"):
                self.settings = {"username": username, "pending_2fa": True}
                raise TwoFactorRequiredError("private-password")
            self.logged_in = True
            self.settings = {"username": username, "device": "stable-device"}

    store = CredentialStore(tmp_path / "secure")
    app = create_app(store=store, client_factory=TwoFactorClient)
    client = TestClient(app, headers={"Authorization": f"Bearer {app.state.token}"})
    login = client.post(
        "/accounts/login",
        json={"accountId": "account-2fa", "username": "test_account", "password": "private-password"},
    )
    assert login.status_code == 409
    assert login.json()["detail"]["errorCode"] == "IG_2FA_REQUIRED"
    assert login.json()["detail"]["requiresAction"] is True
    assert client.get("/accounts/account-2fa/health").json()["loginState"] == "2FA_REQUIRED"
    assert "private-password" not in (store.data_dir / "account-2fa.enc").read_bytes().decode("latin1")

    continued = client.post("/accounts/account-2fa/login/continue", json={"verificationCode": "123456"})
    assert continued.status_code == 200
    assert continued.json()["sessionStatus"] == "VALID"
    assert client.get("/accounts/account-2fa/health").json()["status"] == "GREEN"
    assert store.load("account-2fa")["lastError"] is None
    assert "LOGIN_2FA_REQUIRED accountId=account-2fa" in caplog.text


def test_challenge_is_reported_and_recheck_uses_approved_session(tmp_path):
    class ChallengeRequiredError(Exception):
        pass

    approved = {"value": False}

    class ChallengeClient(FakeClient):
        def login(self, username, password, **kwargs):
            self.settings = {"username": username, "challenge_pending": True}
            raise ChallengeRequiredError("challenge")

        def account_info(self):
            if self.settings.get("challenge_pending") and not approved["value"]:
                raise ChallengeRequiredError("challenge")
            return {"username": "test_account", "pk": "123"}

    store = CredentialStore(tmp_path / "secure")
    app = create_app(store=store, client_factory=ChallengeClient)
    client = TestClient(app, headers={"Authorization": f"Bearer {app.state.token}"})
    login = client.post(
        "/accounts/login",
        json={"accountId": "account-challenge", "username": "test_account", "password": "private-password"},
    )
    assert login.status_code == 409
    assert login.json()["detail"]["errorCode"] == "IG_CHALLENGE_REQUIRED"
    assert client.get("/accounts/account-challenge/health").json()["loginState"] == "CHALLENGE_REQUIRED"

    approved["value"] = True
    rechecked = client.post("/accounts/account-challenge/login/recheck", json={})
    assert rechecked.status_code == 200
    assert rechecked.json()["sessionStatus"] == "VALID"
    assert client.get("/accounts/account-challenge/health").json()["status"] == "GREEN"


def test_saved_session_is_reused_after_worker_restart_without_password_login(tmp_path):
    first_store = CredentialStore(tmp_path / "secure")
    first_app = create_app(store=first_store, client_factory=FakeClient)
    first = TestClient(first_app, headers={"Authorization": f"Bearer {first_app.state.token}"})
    assert first.post(
        "/accounts/login",
        json={"accountId": "account-restart", "username": "test_account", "password": "private-password"},
    ).status_code == 200

    class SessionOnlyClient(FakeClient):
        def login(self, username, password, **kwargs):
            raise AssertionError("saved session should be validated without password login")

    restarted_store = CredentialStore(tmp_path / "secure")
    restarted_app = create_app(store=restarted_store, client_factory=SessionOnlyClient)
    restarted = TestClient(restarted_app, headers={"Authorization": f"Bearer {restarted_app.state.token}"})
    health = restarted.get("/accounts/account-restart/health")
    assert health.status_code == 200
    assert health.json()["status"] == "GREEN"
    assert health.json()["sessionStatus"] == "VALID"
    assert restarted_store.load("account-restart")["session"]["device"] == "stable-device"


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


def test_reel_publish_uses_temporary_thumbnail_and_calls_clip_upload_once(tmp_path):
    calls = []

    class TrackingClient(FakeClient):
        def clip_upload(self, path, caption, **kwargs):
            calls.append((path, caption, kwargs))
            assert kwargs["thumbnail"].is_file()
            assert kwargs["thumbnail"].parent != path.parent
            return FakeMedia()

    def write_test_thumbnail(_video_path: Path, thumbnail_path: Path):
        thumbnail_path.write_bytes(b"test-thumbnail")

    store = CredentialStore(tmp_path / "secure")
    upload_root = tmp_path / "uploads"
    upload_root.mkdir()
    video = upload_root / "reel.mp4"
    video.write_bytes(b"mock video")
    app = create_app(
        store=store,
        client_factory=TrackingClient,
        media_root=upload_root,
        thumbnail_generator=write_test_thumbnail,
    )
    client = TestClient(app, headers={"Authorization": f"Bearer {app.state.token}"})
    assert client.post("/accounts/login", json={"accountId": "reel-a", "username": "u", "password": "p"}).status_code == 200

    response = client.post(
        "/publish/reel",
        json={"accountId": "reel-a", "videoPath": str(video), "caption": "Local test", "trialReel": False},
    )

    assert response.status_code == 200
    assert len(calls) == 1
    uploaded_path, caption, options = calls[0]
    assert uploaded_path == video.resolve()
    assert caption == "Local test"
    assert options["trial"] is False
    assert not options["thumbnail"].exists()
    assert not (upload_root / "reel.mp4.jpg").exists()


def test_reel_publish_logs_safe_exception_diagnostics_without_retry_or_secret_leak(tmp_path, caplog):
    calls = []

    class ClipUploadError(Exception):
        status_code = 413
        error_type = "MediaRejected"
        code = "UPLOAD_REJECTED"

    class FailingClient(FakeClient):
        def login(self, username, password, **kwargs):
            self.logged_in = True
            self.settings = {"username": username, "cookies": {"sessionid": "private-session-cookie", "csrftoken": "private-csrf"}}

        def clip_upload(self, path, caption, **kwargs):
            calls.append((path, caption, kwargs))
            raise ClipUploadError(
                "Upload rejected username=private-user password=private-password sessionid=private-session-cookie "
                "Cookie: private-cookie csrf=private-csrf "
                "proxy=http://proxy-user:proxy-password@proxy.example:8080"
            )

    def write_test_thumbnail(_video_path: Path, thumbnail_path: Path):
        thumbnail_path.write_bytes(b"test-thumbnail")

    caplog.set_level(logging.ERROR, logger="sns-instagram-worker")
    store = CredentialStore(tmp_path / "secure")
    upload_root = tmp_path / "uploads"
    upload_root.mkdir()
    video = upload_root / "reel.mp4"
    video.write_bytes(b"mock video")
    app = create_app(
        store=store,
        client_factory=FailingClient,
        media_root=upload_root,
        thumbnail_generator=write_test_thumbnail,
    )
    client = TestClient(app, headers={"Authorization": f"Bearer {app.state.token}"})
    login = client.post(
        "/accounts/login",
        json={
            "accountId": "reel-failed",
            "username": "private-user",
            "password": "private-password",
            "proxy": "http://proxy-user:proxy-password@proxy.example:8080",
        },
    )
    assert login.status_code == 200

    response = client.post(
        "/publish/reel",
        json={"accountId": "reel-failed", "videoPath": str(video), "caption": "Local test", "trialReel": False},
    )

    assert response.status_code == 502
    assert response.json()["detail"]["code"] == "IG_UPLOAD_FAILED"
    assert len(calls) == 1
    assert "exceptionClass=ClipUploadError" in caplog.text
    assert "exceptionModule=test_worker" in caplog.text
    assert "statusCode=413" in caplog.text
    assert "errorType=MediaRejected" in caplog.text
    assert "remoteCode=UPLOAD_REJECTED" in caplog.text
    assert "message=Upload rejected" in caplog.text
    for secret in (
        "private-password",
        "private-session-cookie",
        "private-csrf",
        "private-cookie",
        "proxy-user",
        "proxy-password",
        "private-user",
    ):
        assert secret not in caplog.text
        assert secret not in response.text


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
    def write_test_thumbnail(_video_path: Path, thumbnail_path: Path):
        thumbnail_path.write_bytes(b"test-thumbnail")

    app = create_app(store=store, media_root=upload_root, thumbnail_generator=write_test_thumbnail)
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


def test_story_video_upload_uses_temporary_thumbnail_and_serializes_story_link_once(tmp_path):
    from instagrapi.types import StoryLink

    calls = []
    generated = []

    class TrackingClient(FakeClient):
        def video_upload_to_story(self, path, **kwargs):
            thumbnail = kwargs["thumbnail"]
            assert thumbnail.is_file()
            assert thumbnail.parent != path.parent
            calls.append((path, kwargs))
            return FakeMedia()

    def write_test_thumbnail(video_path: Path, thumbnail_path: Path):
        generated.append((video_path, thumbnail_path))
        thumbnail_path.write_bytes(b"test-story-thumbnail")

    store = CredentialStore(tmp_path / "secure")
    upload_root = tmp_path / "uploads"
    upload_root.mkdir()
    video = upload_root / "story.mp4"
    video.write_bytes(b"mock video")
    app = create_app(
        store=store,
        client_factory=TrackingClient,
        media_root=upload_root,
        thumbnail_generator=write_test_thumbnail,
    )
    client = TestClient(app, headers={"Authorization": f"Bearer {app.state.token}"})
    assert client.post("/accounts/login", json={"accountId": "story-video", "username": "u", "password": "p"}).status_code == 200

    response = client.post(
        "/publish/story",
        json={
            "accountId": "story-video",
            "mediaPath": str(video),
            "mediaType": "video",
            "linkUrl": "https://example.com/",
            "sticker": {"x": 0.5, "y": 0.5, "width": 0.51, "height": 0.26, "rotation": 0},
        },
    )

    assert response.status_code == 200
    assert response.json()["mediaType"] == "STORY"
    assert len(calls) == 1
    uploaded_video, options = calls[0]
    assert uploaded_video == video.resolve()
    assert options["thumbnail"] == generated[0][1]
    assert not options["thumbnail"].exists()
    assert len(options["links"]) == 1
    assert isinstance(options["links"][0], StoryLink)
    assert options["links"][0].model_dump(mode="json") == {
        "webUri": "https://example.com/",
        "x": 0.5,
        "y": 0.5,
        "z": 0.0,
        "width": 0.51,
        "height": 0.26,
        "rotation": 0.0,
    }
    assert not (upload_root / "story.mp4.jpg").exists()


def test_story_link_serialization_and_empty_link_payload_are_offline():
    from instagrapi import Client
    from instagrapi.types import StoryLink

    client = Client()
    calls = []

    def capture_private_request(endpoint, data):
        calls.append((endpoint, data))
        return data

    client.private_request = capture_private_request
    link = StoryLink(webUri="https://example.com/", x=0.5, y=0.5, width=0.51, height=0.26, rotation=0)
    client.video_configure_to_story("upload-id", 1080, 1920, 3.675, Path("/tmp/story-thumbnail.jpg"), "", links=[link])

    assert [endpoint for endpoint, _ in calls] == [
        "media/validate_reel_url/",
        "media/configure_to_story/?video=1",
    ]
    assert calls[0][1]["url"] == "https://example.com/"
    payload = calls[1][1]
    sticker = json.loads(payload["tap_models"])[0]
    assert sticker == {
        "x": 0.5,
        "y": 0.5,
        "z": 0,
        "width": 0.51,
        "height": 0.26,
        "rotation": 0.0,
        "type": "story_link",
        "is_sticker": True,
        "selected_index": 0,
        "tap_state": 0,
        "link_type": "web",
        "url": "https://example.com/",
        "tap_state_str_id": "link_sticker_default",
    }
    assert payload["story_sticker_ids"] == "link_sticker_default"

    calls.clear()
    client.video_configure_to_story("upload-id", 1080, 1920, 3.675, Path("/tmp/story-thumbnail.jpg"), "", links=[])
    assert [endpoint for endpoint, _ in calls] == ["media/configure_to_story/?video=1"]
    assert "tap_models" not in calls[0][1]
    assert "story_sticker_ids" not in calls[0][1]


def test_story_error_mapping_covers_account_network_link_media_and_upload_failures():
    from app.main import _story_error_code, _story_failure_category

    cases = [
        ("ChallengeRequired", "challenge", "video_upload_to_story", "IG_CHALLENGE_REQUIRED", 409, "account_action"),
        ("FeedbackRequired", "feedback", "video_upload_to_story", "IG_FEEDBACK_REQUIRED", 409, "account_action"),
        ("RateLimitError", "slow down", "video_upload_to_story", "IG_RATE_LIMITED", 429, "rate_limit"),
        ("ConnectTimeout", "timed out", "video_upload_to_story", "IG_NETWORK_ERROR", 502, "network"),
        ("InvalidURL", "invalid Story URL", "story_link_build", "IG_STORY_LINK_INVALID", 422, "story_link"),
        ("OSError", "read-only file system", "thumbnail_generation", "IG_MEDIA_PROCESSING_FAILED", 422, "media"),
        ("ClientBadRequestError", "media rejected", "video_upload_to_story", "IG_MEDIA_REJECTED", 422, "upload"),
        ("VideoConfigureStoryError", "configure failed", "video_upload_to_story", "IG_STORY_UPLOAD_FAILED", 502, "upload"),
        ("UnknownStoryError", "unknown", "video_upload_to_story", "IG_STORY_UPLOAD_FAILED", 502, "upload"),
    ]
    for name, message, stage, expected_code, expected_status, expected_category in cases:
        error_type = type(name, (Exception,), {})
        code, _, status = _story_error_code(error_type(message), stage)
        assert (code, status) == (expected_code, expected_status)
        assert _story_failure_category(code, stage) == expected_category


def test_story_upload_logs_sanitized_diagnostics_and_never_retries(tmp_path, caplog):
    calls = []

    class StoryUploadError(Exception):
        status_code = 413
        error_type = "VideoConfigureRejected"
        code = "STORY_UPLOAD_REJECTED"

    class FailingClient(FakeClient):
        def login(self, username, password, **kwargs):
            self.logged_in = True
            self.settings = {
                "username": username,
                "cookies": {"sessionid": "private-session-cookie", "csrftoken": "private-csrf"},
                "device": {"device_id": "private-device-id"},
            }

        def video_upload_to_story(self, path, **kwargs):
            calls.append((path, kwargs))
            raise StoryUploadError(
                "video upload failed username=private-user password=private-password "
                "sessionid=private-session-cookie cookie=private-cookie csrf=private-csrf "
                "proxy=http://proxy-user:proxy-password@proxy.example:8080 "
                "https://example.com/?token=private-url-token"
            )

    def write_test_thumbnail(_video_path: Path, thumbnail_path: Path):
        thumbnail_path.write_bytes(b"test-thumbnail")

    caplog.set_level(logging.ERROR, logger="sns-instagram-worker")
    store = CredentialStore(tmp_path / "secure")
    upload_root = tmp_path / "uploads"
    upload_root.mkdir()
    video = upload_root / "story.mp4"
    video.write_bytes(b"mock video")
    app = create_app(
        store=store,
        client_factory=FailingClient,
        media_root=upload_root,
        thumbnail_generator=write_test_thumbnail,
    )
    client = TestClient(app, headers={"Authorization": f"Bearer {app.state.token}"})
    login = client.post(
        "/accounts/login",
        json={
            "accountId": "story-failed",
            "username": "private-user",
            "password": "private-password",
            "proxy": "http://proxy-user:proxy-password@proxy.example:8080",
        },
    )
    assert login.status_code == 200

    response = client.post(
        "/publish/story",
        json={
            "accountId": "story-failed",
            "mediaPath": str(video),
            "mediaType": "video",
            "linkUrl": "https://example.com/",
            "sticker": {"x": 0.5, "y": 0.5, "width": 0.51, "height": 0.26, "rotation": 0},
        },
    )

    assert response.status_code == 502
    assert response.json()["detail"]["code"] == "IG_STORY_UPLOAD_FAILED"
    assert len(calls) == 1
    assert "PUBLISH_FAILURE accountId=story-failed stage=video_upload_to_story failureCategory=upload" in caplog.text
    assert "errorCode=IG_STORY_UPLOAD_FAILED" in caplog.text
    assert "exceptionClass=StoryUploadError" in caplog.text
    assert "exceptionModule=test_worker" in caplog.text
    assert "statusCode=413" in caplog.text
    assert "errorType=VideoConfigureRejected" in caplog.text
    assert "remoteCode=STORY_UPLOAD_REJECTED" in caplog.text
    assert "message=video upload failed" in caplog.text
    for secret in (
        "private-user",
        "private-password",
        "private-session-cookie",
        "private-csrf",
        "private-cookie",
        "private-device-id",
        "proxy-user",
        "proxy-password",
        "private-url-token",
    ):
        assert secret not in caplog.text
        assert secret not in response.text
