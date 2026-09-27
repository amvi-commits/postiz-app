from __future__ import annotations

import os
import secrets
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
import httpx

from .crypto_store import CredentialStore, CredentialStoreError
from .schemas import (
    LoginRequest,
    PublishReelRequest,
    PublishResponse,
    PublishStoryRequest,
    ProxyTestRequest,
)

ClientFactory = Callable[[], Any]


class _MockMedia:
    def __init__(self, media_id: str):
        self.pk = media_id
        self.code = f"mock{media_id[-6:]}"


class _MockInstagramClient:
    """Local-only adapter for credential-free UI and publish tests."""

    def __init__(self):
        self.settings: dict[str, Any] = {}
        self.username = "mock_account"

    def set_proxy(self, proxy: str):
        self.proxy = proxy

    def set_settings(self, settings: dict[str, Any]):
        self.settings = settings
        self.username = settings.get("username", self.username)

    def login(self, username: str, password: str, **kwargs):
        self.username = username
        self.settings = {"username": username, "device": "sns-studio-local-mock"}
        return True

    def get_settings(self):
        return self.settings

    def account_info(self):
        return {"username": self.username, "pk": f"mock-{self.username}", "follower_count": 42}

    def clip_trial_eligible(self):
        return True

    def clip_upload(self, path, caption, **kwargs):
        return _MockMedia(f"mock-reel-{secrets.token_hex(6)}")

    def photo_upload_to_story(self, path, **kwargs):
        return _MockMedia(f"mock-story-{secrets.token_hex(6)}")

    def video_upload_to_story(self, path, **kwargs):
        return _MockMedia(f"mock-story-{secrets.token_hex(6)}")

    def media_info(self, media_id):
        return {"pk": media_id, "metrics": {"views": 42, "plays": 38, "likes": 7, "comments": 2, "saves": 1}}


def _default_client_factory() -> Any:
    if os.getenv("SNS_STUDIO_INSTAGRAM_MOCK", "false").lower() in {"1", "true", "yes"}:
        return _MockInstagramClient()
    from instagrapi import Client

    return Client()


def _public_model(value: Any) -> dict[str, Any]:
    if hasattr(value, "model_dump"):
        data = value.model_dump(mode="json")
    elif hasattr(value, "dict"):
        data = value.dict()
    elif isinstance(value, dict):
        data = value
    else:
        data = vars(value)
    allowed = {
        "pk", "id", "username", "full_name", "biography", "profile_pic_url",
        "follower_count", "following_count", "media_count", "is_private",
        "is_verified", "category", "external_url", "like_count", "comment_count",
        "view_count", "play_count", "save_count", "metrics",
    }
    return {key: data[key] for key in allowed if key in data}


def _error_code(exc: Exception) -> tuple[str, str, int]:
    name = exc.__class__.__name__.lower()
    if "twofactor" in name or "2fa" in name:
        return "IG_2FA_REQUIRED", "Enter the current Instagram verification code.", 409
    if "challenge" in name or "checkpoint" in name or "consentrequired" in name:
        return "IG_CHALLENGE_REQUIRED", "Instagram requires an account confirmation step.", 409
    if "loginrequired" in name or "loginrequired" in str(exc).lower():
        return "IG_LOGIN_REQUIRED", "The Instagram session needs a new login.", 401
    if "pleasewait" in name or "ratelimit" in name:
        return "IG_RATE_LIMITED", "Instagram temporarily limited this action. Try again later.", 429
    return "IG_REQUEST_FAILED", "Instagram could not complete the request.", 502


def create_app(
    *,
    store: CredentialStore | None = None,
    client_factory: ClientFactory = _default_client_factory,
    media_root: Path | None = None,
) -> FastAPI:
    app = FastAPI(title="SNS Studio Instagram Worker", version="1.0.0")
    app.state.store = store or CredentialStore(Path(os.getenv("IG_DATA_DIR", "./data")))
    app.state.client_factory = client_factory
    app.state.media_root = (
        media_root or Path(os.getenv("IG_MEDIA_ROOT", "./uploads"))
    ).resolve()

    app.state.token = _ensure_service_token()

    @app.middleware("http")
    async def require_internal_token(request: Request, call_next):
        expected = app.state.token
        if request.url.path != "/health" and expected:
            received = request.headers.get("authorization", "")
            if not secrets.compare_digest(received, f"Bearer {expected}"):
                return JSONResponse(status_code=401, content={"detail": "Unauthorized"})
        return await call_next(request)

    def credentials(account_id: str) -> dict[str, Any]:
        try:
            result = app.state.store.load(account_id)
        except CredentialStoreError as exc:
            raise HTTPException(status_code=500, detail={"code": "IG_SESSION_STORE_ERROR"}) from exc
        if result is None:
            raise HTTPException(status_code=404, detail={"code": "IG_LOGIN_REQUIRED"})
        return result

    def client_for(account_id: str, *, verification_code: str | None = None) -> tuple[Any, dict[str, Any]]:
        record = credentials(account_id)
        client = app.state.client_factory()
        if record.get("session"):
            client.set_settings(record["session"])
        if record.get("proxy"):
            client.set_proxy(record["proxy"])
        try:
            if verification_code:
                client.login(record["username"], record["password"], verification_code=verification_code)
            else:
                # instagrapi validates a loaded session before attempting password login.
                client.login(record["username"], record["password"])
        except Exception as exc:
            code, message, status = _error_code(exc)
            raise HTTPException(status_code=status, detail={"code": code, "message": message}) from None
        record["session"] = client.get_settings()
        record["status"] = "ACTIVE"
        app.state.store.save(account_id, record)
        return client, record

    def media_path(value: str) -> Path:
        requested = Path(value)
        path = requested if requested.is_absolute() else app.state.media_root / requested
        resolved = path.resolve()
        try:
            resolved.relative_to(app.state.media_root)
        except ValueError:
            raise HTTPException(status_code=400, detail={"code": "MEDIA_PATH_INVALID"}) from None
        if not resolved.is_file():
            raise HTTPException(status_code=404, detail={"code": "MEDIA_NOT_FOUND"})
        return resolved

    @app.get("/health")
    def health():
        return {"status": "ok", "service": "instagram-worker"}

    @app.post("/proxy/test")
    def test_proxy(body: ProxyTestRequest):
        try:
            response = httpx.get(
                "https://www.instagram.com/robots.txt",
                proxy=body.proxy,
                timeout=10.0,
                follow_redirects=True,
            )
            return {"reachable": response.status_code < 500, "statusCode": response.status_code}
        except Exception:
            return {"reachable": False, "statusCode": None, "code": "PROXY_CONNECTION_FAILED"}

    @app.post("/accounts/login")
    def login(body: LoginRequest):
        client = app.state.client_factory()
        if body.proxy:
            client.set_proxy(body.proxy)
        try:
            if body.verificationCode:
                client.login(body.username, body.password, verification_code=body.verificationCode)
            else:
                client.login(body.username, body.password)
        except Exception as exc:
            code, message, status = _error_code(exc)
            raise HTTPException(status_code=status, detail={"code": code, "message": message}) from None
        app.state.store.save(
            body.accountId,
            {
                "username": body.username,
                "password": body.password,
                "proxy": body.proxy,
                "session": client.get_settings(),
                "status": "ACTIVE",
            },
        )
        return {"accountId": body.accountId, "status": "ACTIVE", "username": body.username}

    @app.delete("/accounts/{account_id}")
    def delete_account(account_id: str):
        try:
            app.state.store.delete(account_id)
        except CredentialStoreError as exc:
            raise HTTPException(status_code=400, detail={"code": "IG_ACCOUNT_ID_INVALID"}) from exc
        return {"accountId": account_id, "deleted": True}

    @app.post("/accounts/{account_id}/validate")
    def validate(account_id: str):
        client, _ = client_for(account_id)
        try:
            info = client.account_info()
        except Exception as exc:
            code, message, status = _error_code(exc)
            raise HTTPException(status_code=status, detail={"code": code, "message": message}) from None
        return {"accountId": account_id, "status": "ACTIVE", "account": _public_model(info)}

    @app.get("/accounts/{account_id}/info")
    def account_info(account_id: str):
        client, _ = client_for(account_id)
        try:
            return {"accountId": account_id, "account": _public_model(client.account_info())}
        except Exception as exc:
            code, message, status = _error_code(exc)
            raise HTTPException(status_code=status, detail={"code": code, "message": message}) from None

    @app.get("/accounts/{account_id}/trial-reel-eligibility")
    def trial_reel_eligibility(account_id: str):
        client, _ = client_for(account_id)
        try:
            eligible = bool(client.clip_trial_eligible())
        except Exception as exc:
            code, message, status = _error_code(exc)
            raise HTTPException(status_code=status, detail={"code": code, "message": message}) from None
        return {"accountId": account_id, "eligible": eligible}

    @app.post("/publish/reel", response_model=PublishResponse)
    def publish_reel(body: PublishReelRequest):
        client, _ = client_for(body.accountId)
        video = media_path(body.videoPath)
        thumbnail = media_path(body.thumbnailPath) if body.thumbnailPath else None
        if body.trialReel:
            try:
                if not client.clip_trial_eligible():
                    raise HTTPException(status_code=409, detail={"code": "IG_TRIAL_NOT_ELIGIBLE"})
            except HTTPException:
                raise
            except Exception as exc:
                code, message, status = _error_code(exc)
                raise HTTPException(status_code=status, detail={"code": code, "message": message}) from None
        try:
            media = client.clip_upload(video, body.caption, thumbnail=thumbnail, trial=body.trialReel)
        except Exception as exc:
            code, message, status = _error_code(exc)
            raise HTTPException(status_code=status, detail={"code": code, "message": message}) from None
        media_id = str(getattr(media, "pk", ""))
        shortcode = getattr(media, "code", None)
        return PublishResponse(
            mediaId=media_id,
            shortcode=shortcode,
            postUrl=f"https://www.instagram.com/reel/{shortcode}/" if shortcode else None,
            publishedAt=datetime.now(timezone.utc).isoformat(),
            mediaType="TRIAL_REEL" if body.trialReel else "REEL",
        )

    @app.post("/publish/story", response_model=PublishResponse)
    def publish_story(body: PublishStoryRequest):
        from instagrapi.types import StoryLink

        client, _ = client_for(body.accountId)
        media = media_path(body.mediaPath)
        sticker = body.sticker
        link = StoryLink(
            webUri=str(body.linkUrl),
            x=sticker.x,
            y=sticker.y,
            width=sticker.width,
            height=sticker.height,
            rotation=sticker.rotation,
        )
        try:
            if body.mediaType == "image":
                published = client.photo_upload_to_story(media, links=[link])
            else:
                published = client.video_upload_to_story(media, links=[link])
        except Exception as exc:
            code, message, status = _error_code(exc)
            raise HTTPException(status_code=status, detail={"code": code, "message": message}) from None
        shortcode = getattr(published, "code", None)
        return PublishResponse(
            mediaId=str(getattr(published, "pk", "")),
            shortcode=shortcode,
            postUrl=None,
            publishedAt=datetime.now(timezone.utc).isoformat(),
            mediaType="STORY",
        )

    @app.get("/insights/media/{media_id}")
    def media_insights(media_id: str, accountId: str):
        client, _ = client_for(accountId)
        try:
            info = client.media_info(media_id)
        except Exception as exc:
            code, message, status = _error_code(exc)
            raise HTTPException(status_code=status, detail={"code": code, "message": message}) from None
        data = _public_model(info)
        return {"mediaId": media_id, "metrics": data.get("metrics", {}), "raw": data}

    @app.get("/accounts/{account_id}/health")
    def account_health(account_id: str):
        record = None
        try:
            record = credentials(account_id)
            client, record = client_for(account_id)
            client.account_info()
            return {"accountId": account_id, "status": "GREEN", "session": "VALID", "proxyConfigured": bool(record.get("proxy")), "lastError": None}
        except HTTPException as exc:
            detail = exc.detail if isinstance(exc.detail, dict) else {}
            status = "NEEDS_USER_ACTION" if detail.get("code") in {
                "IG_LOGIN_REQUIRED", "IG_CHALLENGE_REQUIRED", "IG_2FA_REQUIRED"
            } else "RED"
            return {
                "accountId": account_id,
                "status": status,
                "session": "INVALID",
                "proxyConfigured": bool(record.get("proxy")) if record else None,
                "lastError": detail.get("code", "IG_REQUEST_FAILED"),
            }
        except Exception:
            return {
                "accountId": account_id,
                "status": "YELLOW",
                "session": "VALIDATION_FAILED",
                "proxyConfigured": bool(record.get("proxy")) if record else None,
                "lastError": "IG_REQUEST_FAILED",
            }

    return app


def _ensure_service_token() -> str | None:
    token = os.getenv("SNS_STUDIO_SERVICE_TOKEN") or os.getenv("IG_WORKER_API_TOKEN")
    token_path_setting = os.getenv("IG_WORKER_TOKEN_FILE")
    if token:
        return token
    if not token_path_setting:
        return None
    token_path = Path(token_path_setting)
    token_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(token_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return token_path.read_text(encoding="utf-8").strip()
    token = secrets.token_urlsafe(32)
    with os.fdopen(fd, "w", encoding="utf-8") as token_file:
        token_file.write(token + "\n")
        token_file.flush()
        os.fsync(token_file.fileno())
    return token


app = create_app()
