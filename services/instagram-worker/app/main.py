from __future__ import annotations

import os
import logging
import re
import secrets
import tempfile
from collections.abc import Mapping
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
import httpx

from .crypto_store import CredentialStore, CredentialStoreError
from .story_visual import StoryVisualInputError, render_story_link_video
from .schemas import (
    LoginRequest,
    LoginCodeRequest,
    PublishReelRequest,
    PublishResponse,
    PublishStoryRequest,
    ProxyTestRequest,
    StickerPosition,
)

ClientFactory = Callable[[], Any]
ThumbnailGenerator = Callable[[Path, Path], None]
StoryVisualRenderer = Callable[[Path, Path, str, StickerPosition], dict[str, Any]]
logger = logging.getLogger("sns-instagram-worker")
ACTION_REQUIRED_CODES = {"IG_LOGIN_REQUIRED", "IG_2FA_REQUIRED", "IG_CHALLENGE_REQUIRED"}
_SAFE_DIAGNOSTIC_VALUE = re.compile(r"^[A-Za-z0-9_.-]{1,80}$")
_SENSITIVE_KEY = re.compile(r"username|password|passwd|session|cookie|csrf|auth|token|secret|proxy|device", re.I)
_SECRET_ASSIGNMENT = re.compile(
    r"(?i)(\b(?:username|password|passwd|sessionid|cookie|set-cookie|csrf(?:token)?|authorization|proxy-authorization|token|secret|api[_-]?key)\b\s*[:=]\s*)(?:\"[^\"]*\"|'[^']*'|[^\s,;}\]]+)"
)
_URL = re.compile(r"https?://[^\s\]\[{}<>\"']+", re.I)
_BEARER = re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+")
_JWT = re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b")
_SAFE_ERROR_TYPE = re.compile(r"^[A-Z][A-Za-z0-9_.-]{0,79}$")
_SAFE_REMOTE_CODE = re.compile(r"^[A-Z0-9][A-Z0-9_.-]{0,79}$")
_SAFE_ACCOUNT_ID = re.compile(r"^[A-Za-z0-9_-]{1,100}$")


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


def _generate_video_thumbnail(video_path: Path, thumbnail_path: Path) -> None:
    """Generate an instagrapi-compatible thumbnail without writing beside shared media."""
    from instagrapi.mixins.clip import crop_thumbnail
    from instagrapi.utils.video import generate_video_thumbnail, read_video_metadata_with_fallback

    metadata = read_video_metadata_with_fallback(video_path)
    generate_video_thumbnail(
        video_path,
        thumbnail_path,
        duration=metadata.duration,
        crop_thumbnail=crop_thumbnail,
    )


def _collect_sensitive_values(value: Any, *, sensitive_parent: bool = False) -> list[str]:
    values: list[str] = []
    if isinstance(value, Mapping):
        for key, nested in value.items():
            values.extend(
                _collect_sensitive_values(
                    nested,
                    sensitive_parent=sensitive_parent or bool(_SENSITIVE_KEY.search(str(key))),
                )
            )
    elif isinstance(value, (list, tuple, set)):
        for nested in value:
            values.extend(_collect_sensitive_values(nested, sensitive_parent=sensitive_parent))
    elif sensitive_parent and isinstance(value, (str, int, float)) and str(value):
        values.append(str(value))
    return values


def _redact_structured_payloads(message: str) -> str:
    """Remove dict/list payloads wholesale so arbitrary session JSON cannot enter logs."""
    result: list[str] = []
    index = 0
    while index < len(message):
        opening = message[index]
        if opening not in "[{":
            result.append(opening)
            index += 1
            continue

        stack = ["}" if opening == "{" else "]"]
        quote: str | None = None
        escaped = False
        end = index + 1
        while end < len(message) and stack:
            char = message[end]
            if quote:
                if escaped:
                    escaped = False
                elif char == "\\":
                    escaped = True
                elif char == quote:
                    quote = None
            elif char in "\"'":
                quote = char
            elif char == "{":
                stack.append("}")
            elif char == "[":
                stack.append("]")
            elif char == stack[-1]:
                stack.pop()
            end += 1

        if stack:
            result.append("[structured data redacted]")
            break
        result.append("[structured data redacted]")
        index = end
    return "".join(result)


def _safe_exception_message(exc: Exception, sensitive_values: list[str]) -> str:
    try:
        message = str(exc)
    except Exception:
        return "[exception message unavailable]"

    for secret in sorted(set(sensitive_values), key=len, reverse=True):
        if secret:
            message = message.replace(secret, "[REDACTED]")
    message = _redact_structured_payloads(message)
    message = _URL.sub("[URL redacted]", message)
    message = _BEARER.sub("Bearer [REDACTED]", message)
    message = _JWT.sub("[TOKEN redacted]", message)
    message = _SECRET_ASSIGNMENT.sub(r"\1[REDACTED]", message)
    message = re.sub(r"\s+", " ", message).strip()
    return message[:400] or "[empty exception message]"


def _safe_exception_attribute(exc: Exception, name: str) -> str | None:
    try:
        value = getattr(exc, name, None)
    except Exception:
        return None
    if isinstance(value, (str, int)) and not isinstance(value, bool):
        result = str(value)
        if name in {"error_type", "errorType"} and _SAFE_ERROR_TYPE.fullmatch(result):
            return result
        if name in {"error_code", "code"} and _SAFE_REMOTE_CODE.fullmatch(result):
            return result
        if name not in {"error_type", "errorType", "error_code", "code"} and _SAFE_DIAGNOSTIC_VALUE.fullmatch(result):
            return result
    return None


def _exception_status_code(exc: Exception) -> int | None:
    candidates = [exc]
    try:
        response = getattr(exc, "response", None)
    except Exception:
        response = None
    if response is not None:
        candidates.append(response)
    for candidate in candidates:
        try:
            status = getattr(candidate, "status_code", None)
        except Exception:
            continue
        if isinstance(status, int) and not isinstance(status, bool) and 100 <= status <= 599:
            return status
    return None


def _log_publish_exception(
    exc: Exception,
    *,
    account_id: str,
    stage: str,
    error_code: str,
    credential_record: dict[str, Any],
    failure_category: str = "unknown",
) -> None:
    exception_type = type(exc)
    exception_class = exception_type.__name__
    exception_module = exception_type.__module__
    safe_class = exception_class if _SAFE_DIAGNOSTIC_VALUE.fullmatch(exception_class) else "UnknownException"
    safe_module = exception_module if _SAFE_DIAGNOSTIC_VALUE.fullmatch(exception_module) else "unknown"
    safe_account_id = account_id if _SAFE_ACCOUNT_ID.fullmatch(account_id) else "invalid"
    logger.error(
        "PUBLISH_FAILURE accountId=%s stage=%s failureCategory=%s errorCode=%s exceptionClass=%s exceptionModule=%s "
        "statusCode=%s errorType=%s remoteCode=%s message=%s",
        safe_account_id,
        stage,
        failure_category if _SAFE_DIAGNOSTIC_VALUE.fullmatch(failure_category) else "unknown",
        error_code,
        safe_class,
        safe_module,
        _exception_status_code(exc),
        _safe_exception_attribute(exc, "error_type") or _safe_exception_attribute(exc, "errorType") or "",
        _safe_exception_attribute(exc, "error_code") or _safe_exception_attribute(exc, "code") or "",
        _safe_exception_message(exc, _collect_sensitive_values(credential_record)),
    )


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
    message = str(exc).lower()
    if "badpassword" in name or "badcredentials" in name or "invalidpassword" in name:
        return "IG_BAD_PASSWORD", "Instagram rejected the username or password.", 401
    if "twofactor" in name or "2fa" in name:
        return "IG_2FA_REQUIRED", "Enter the current Instagram verification code.", 409
    if "challenge" in name or "checkpoint" in name or "consentrequired" in name:
        return "IG_CHALLENGE_REQUIRED", "Instagram requires an account confirmation step.", 409
    if "feedbackrequired" in name:
        return "IG_FEEDBACK_REQUIRED", "Instagram requires an account confirmation step.", 409
    if "loginrequired" in name or "loginrequired" in message:
        return "IG_LOGIN_REQUIRED", "The Instagram session needs a new login.", 401
    if "pleasewait" in name or "ratelimit" in name or "too many requests" in message or "rate limit" in message:
        return "IG_RATE_LIMITED", "Instagram temporarily limited this action. Try again later.", 429
    if any(token in name for token in ("connectionerror", "connecttimeout", "readtimeout", "proxyerror", "networkerror", "sslerror")):
        return "IG_NETWORK_ERROR", "A network error interrupted the Instagram request.", 502
    if any(token in name for token in ("badrequest", "mediarejected")):
        return "IG_MEDIA_REJECTED", "Instagram rejected the Reel media or request.", 422
    if any(token in name for token in ("upload", "clipconfigure", "videoconfigure")):
        return "IG_UPLOAD_FAILED", "The Instagram Reel upload did not complete.", 502
    if "runtimeerror" in name and any(token in message for token in ("thumbnail", "moviepy", "ffmpeg", "video")):
        return "IG_MEDIA_PROCESSING_FAILED", "The Reel video could not be prepared for upload.", 422
    return "IG_REQUEST_FAILED", "Instagram could not complete the request.", 502


def _story_error_code(exc: Exception, stage: str) -> tuple[str, str, int]:
    """Map Story adapter failures without losing the shared auth/network classifications."""
    name = exc.__class__.__name__.lower()
    message = str(exc).lower()
    if stage == "visual_render":
        if isinstance(exc, StoryVisualInputError):
            return exc.code, str(exc), 422
        return "IG_STORY_VISUAL_RENDER_FAILED", "The visible Story link video could not be prepared.", 422
    if stage == "story_link_build" or (
        any(token in name for token in ("storylink", "urlvalidation", "invalidurl"))
        or ("url" in message and any(token in message for token in ("invalid", "unsupported", "not allowed")))
    ):
        return "IG_STORY_LINK_INVALID", "Instagram rejected the Story link payload.", 422

    code, safe_message, status = _error_code(exc)
    if code == "IG_MEDIA_REJECTED":
        return code, "Instagram rejected the Story media or request.", status
    if code in {
        "IG_BAD_PASSWORD",
        "IG_2FA_REQUIRED",
        "IG_CHALLENGE_REQUIRED",
        "IG_FEEDBACK_REQUIRED",
        "IG_LOGIN_REQUIRED",
        "IG_RATE_LIMITED",
        "IG_NETWORK_ERROR",
    }:
        return code, safe_message, status
    if stage == "thumbnail_generation":
        return "IG_MEDIA_PROCESSING_FAILED", "The Story video could not be prepared for upload.", 422
    if stage in {"video_upload_to_story", "photo_upload_to_story"} or code == "IG_UPLOAD_FAILED":
        return "IG_STORY_UPLOAD_FAILED", "Instagram Story upload did not complete.", 502
    return code, safe_message, status


def _story_failure_category(error_code: str, stage: str) -> str:
    if stage in {"thumbnail_generation", "visual_render"} or error_code == "IG_MEDIA_PROCESSING_FAILED":
        return "media"
    if error_code == "IG_STORY_LINK_INVALID":
        return "story_link"
    if error_code == "IG_NETWORK_ERROR":
        return "network"
    if error_code == "IG_RATE_LIMITED":
        return "rate_limit"
    if error_code in {"IG_LOGIN_REQUIRED", "IG_2FA_REQUIRED", "IG_CHALLENGE_REQUIRED", "IG_FEEDBACK_REQUIRED"}:
        return "account_action"
    if error_code in {"IG_MEDIA_REJECTED", "IG_STORY_UPLOAD_FAILED"}:
        return "upload"
    return "library"


def _masked_username(username: str) -> str:
    value = username.strip()
    if "@" in value:
        local, domain = value.rsplit("@", 1)
        return f"{local[:1]}***@{domain}"
    if len(value) < 3:
        return "***"
    return f"{value[:2]}***{value[-1:]}"


def _error_detail(code: str, message: str) -> dict[str, Any]:
    return {
        "code": code,
        "errorCode": code,
        "message": message,
        "requiresAction": code in ACTION_REQUIRED_CODES,
    }


def create_app(
    *,
    store: CredentialStore | None = None,
    client_factory: ClientFactory = _default_client_factory,
    media_root: Path | None = None,
    thumbnail_generator: ThumbnailGenerator = _generate_video_thumbnail,
    story_visual_renderer: StoryVisualRenderer = render_story_link_video,
) -> FastAPI:
    app = FastAPI(title="SNS Studio Instagram Worker", version="1.0.0")
    app.state.store = store or CredentialStore(Path(os.getenv("IG_DATA_DIR", "./data")))
    app.state.client_factory = client_factory
    app.state.thumbnail_generator = thumbnail_generator
    app.state.story_visual_renderer = story_visual_renderer
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

    def client_for(account_id: str) -> tuple[Any, dict[str, Any]]:
        record = credentials(account_id)
        client = app.state.client_factory()
        if not record.get("session"):
            logger.warning("SESSION_INVALID accountId=%s", account_id)
            code = record.get("lastError")
            if code not in ACTION_REQUIRED_CODES and code != "IG_BAD_PASSWORD":
                code = "IG_LOGIN_REQUIRED"
            message = "Instagram rejected the username or password." if code == "IG_BAD_PASSWORD" else "The Instagram session needs user action."
            raise HTTPException(status_code=401, detail=_error_detail(code, message))
        client.set_settings(record["session"])
        if record.get("proxy"):
            client.set_proxy(record["proxy"])
        return client, record

    def save_valid_session(account_id: str, client: Any, record: dict[str, Any], *, reused: bool) -> None:
        record["session"] = client.get_settings()
        record["status"] = "ACTIVE"
        record["lastError"] = None
        app.state.store.save(account_id, record)
        logger.info("SESSION_SAVED accountId=%s", account_id)
        if reused:
            logger.info("SESSION_REUSED accountId=%s", account_id)

    def save_pending_login(account_id: str, body: LoginRequest, client: Any, code: str) -> None:
        if code not in {"IG_2FA_REQUIRED", "IG_CHALLENGE_REQUIRED"}:
            return
        try:
            session = client.get_settings()
        except Exception:
            session = {}
        app.state.store.save(
            account_id,
            {
                "username": body.username,
                "password": body.password,
                "proxy": body.proxy,
                "session": session,
                "status": "NEEDS_USER_ACTION",
                "lastError": code,
            },
        )
        logger.info("PENDING_LOGIN_SAVED accountId=%s errorCode=%s", account_id, code)

    def login_error(exc: Exception, account_id: str, client: Any, body: LoginRequest | None = None) -> None:
        code, message, status = _error_code(exc)
        if body is not None:
            save_pending_login(account_id, body, client, code)
        if code == "IG_2FA_REQUIRED":
            logger.warning("LOGIN_2FA_REQUIRED accountId=%s", account_id)
        elif code == "IG_CHALLENGE_REQUIRED":
            logger.warning("LOGIN_CHALLENGE_REQUIRED accountId=%s", account_id)
        elif code == "IG_BAD_PASSWORD":
            logger.warning("LOGIN_BAD_PASSWORD accountId=%s", account_id)
        elif code == "IG_LOGIN_REQUIRED":
            logger.warning("SESSION_INVALID accountId=%s", account_id)
        else:
            logger.warning("LOGIN_FAILED accountId=%s errorCode=%s", account_id, code)
        if code == "IG_BAD_PASSWORD" and body is not None:
            app.state.store.save(
                account_id,
                {"username": body.username, "proxy": body.proxy, "session": {}, "status": "ERROR", "lastError": code},
            )
        raise HTTPException(status_code=status, detail=_error_detail(code, message)) from None

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
        logger.info("LOGIN_REQUEST_RECEIVED accountId=%s", body.accountId)
        logger.info("LOGIN_ATTEMPT usernameMasked=%s", _masked_username(body.username))
        client = app.state.client_factory()
        if body.proxy:
            client.set_proxy(body.proxy)
        try:
            if body.verificationCode:
                client.login(body.username, body.password, verification_code=body.verificationCode)
            else:
                client.login(body.username, body.password)
        except Exception as exc:
            login_error(exc, body.accountId, client, body)
        app.state.store.save(
            body.accountId,
            {
                "username": body.username,
                "password": body.password,
                "proxy": body.proxy,
                "session": client.get_settings(),
                "status": "ACTIVE",
                "lastError": None,
            },
        )
        logger.info("LOGIN_SUCCESS accountId=%s", body.accountId)
        logger.info("SESSION_SAVED accountId=%s", body.accountId)
        return {
            "accountId": body.accountId,
            "status": "ACTIVE",
            "sessionStatus": "VALID",
            "loginState": "ACTIVE",
            "requiresAction": False,
            "username": body.username,
        }

    @app.post("/accounts/{account_id}/login/continue")
    def continue_login(account_id: str, body: LoginCodeRequest):
        record = credentials(account_id)
        username = str(record.get("username") or "")
        password = str(record.get("password") or "")
        if not username or not password:
            raise HTTPException(status_code=404, detail=_error_detail("IG_LOGIN_REQUIRED", "Start Instagram login again."))
        logger.info("LOGIN_REQUEST_RECEIVED accountId=%s", account_id)
        logger.info("LOGIN_ATTEMPT usernameMasked=%s", _masked_username(username))
        client = app.state.client_factory()
        if record.get("session"):
            client.set_settings(record["session"])
        if record.get("proxy"):
            client.set_proxy(record["proxy"])
        try:
            client.login(username, password, verification_code=body.verificationCode)
        except Exception as exc:
            pending = LoginRequest(
                accountId=account_id,
                username=username,
                password=password,
                proxy=record.get("proxy"),
                verificationCode=body.verificationCode,
            )
            login_error(exc, account_id, client, pending)
        app.state.store.save(
            account_id,
            {**record, "session": client.get_settings(), "status": "ACTIVE", "lastError": None},
        )
        logger.info("LOGIN_SUCCESS accountId=%s", account_id)
        logger.info("SESSION_SAVED accountId=%s", account_id)
        return {
            "accountId": account_id,
            "status": "ACTIVE",
            "sessionStatus": "VALID",
            "loginState": "ACTIVE",
            "requiresAction": False,
        }

    @app.post("/accounts/{account_id}/login/recheck")
    def recheck_login(account_id: str):
        record = credentials(account_id)
        client = app.state.client_factory()
        if record.get("session"):
            client.set_settings(record["session"])
        if record.get("proxy"):
            client.set_proxy(record["proxy"])
        try:
            account = client.account_info()
        except Exception as first_error:
            if record.get("lastError") != "IG_CHALLENGE_REQUIRED" or not record.get("username") or not record.get("password"):
                login_error(first_error, account_id, client)
            # Instagram app approval may complete the challenge without issuing a new
            # session. Retry the pending login only after the user explicitly rechecks.
            try:
                client.login(record["username"], record["password"])
                account = client.account_info()
            except Exception as retry_error:
                pending = LoginRequest(
                    accountId=account_id,
                    username=record["username"],
                    password=record["password"],
                    proxy=record.get("proxy"),
                )
                login_error(retry_error, account_id, client, pending)
        save_valid_session(account_id, client, record, reused=bool(record.get("session")))
        logger.info("LOGIN_SUCCESS accountId=%s", account_id)
        return {
            "accountId": account_id,
            "status": "ACTIVE",
            "sessionStatus": "VALID",
            "loginState": "ACTIVE",
            "requiresAction": False,
            "account": _public_model(account),
        }

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
            login_error(exc, account_id, client)
        record = credentials(account_id)
        save_valid_session(account_id, client, record, reused=True)
        return {"accountId": account_id, "status": "ACTIVE", "sessionStatus": "VALID", "loginState": "ACTIVE", "requiresAction": False, "account": _public_model(info)}

    @app.get("/accounts/{account_id}/info")
    def account_info(account_id: str):
        client, _ = client_for(account_id)
        try:
            info = client.account_info()
        except Exception as exc:
            login_error(exc, account_id, client)
        return {"accountId": account_id, "account": _public_model(info)}

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
        client, credential_record = client_for(body.accountId)
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
        stage = "thumbnail_generation"
        try:
            if thumbnail is None:
                with tempfile.TemporaryDirectory(prefix="sns-instagram-reel-") as thumbnail_directory:
                    thumbnail = Path(thumbnail_directory) / "thumbnail.jpg"
                    app.state.thumbnail_generator(video, thumbnail)
                    stage = "clip_upload"
                    media = client.clip_upload(video, body.caption, thumbnail=thumbnail, trial=body.trialReel)
            else:
                stage = "clip_upload"
                media = client.clip_upload(video, body.caption, thumbnail=thumbnail, trial=body.trialReel)
        except Exception as exc:
            code, message, status = _error_code(exc)
            _log_publish_exception(
                exc,
                account_id=body.accountId,
                stage=stage,
                error_code=code,
                credential_record=credential_record,
            )
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

    @app.post("/media/preflight/story")
    def preflight_story_visual(body: PublishStoryRequest):
        """Local media/StoryLink check: no credentials, client, or publish calls."""
        from instagrapi.types import StoryLink

        media = media_path(body.mediaPath)
        try:
            link = StoryLink(
                webUri=str(body.linkUrl), x=body.sticker.x, y=body.sticker.y,
                width=body.sticker.width, height=body.sticker.height, rotation=body.sticker.rotation,
            )
            visual = None
            if body.mediaType == "video":
                with tempfile.TemporaryDirectory(prefix="sns-instagram-story-") as directory:
                    visual = app.state.story_visual_renderer(
                        media, Path(directory) / "story-visible-link.mp4", str(body.linkUrl), body.sticker,
                    )
            return {"ready": True, "errors": [], "warnings": [], "visual": visual,
                    "link": link.model_dump(mode="json")}
        except Exception as exc:
            code, message, _ = _story_error_code(exc, "visual_render")
            return {"ready": False, "errors": [code], "warnings": [], "message": message, "visual": None}

    @app.post("/publish/story", response_model=PublishResponse)
    def publish_story(body: PublishStoryRequest):
        from instagrapi.types import StoryLink

        client, credential_record = client_for(body.accountId)
        media = media_path(body.mediaPath)
        sticker = body.sticker
        stage = "story_link_build"
        try:
            link = StoryLink(
                webUri=str(body.linkUrl),
                x=sticker.x,
                y=sticker.y,
                width=sticker.width,
                height=sticker.height,
                rotation=sticker.rotation,
            )
            if body.mediaType == "image":
                stage = "photo_upload_to_story"
                published = client.photo_upload_to_story(media, links=[link])
            else:
                with tempfile.TemporaryDirectory(prefix="sns-instagram-story-") as thumbnail_directory:
                    stage = "visual_render"
                    visible_video = Path(thumbnail_directory) / "story-visible-link.mp4"
                    app.state.story_visual_renderer(media, visible_video, str(body.linkUrl), sticker)
                    stage = "thumbnail_generation"
                    thumbnail = Path(thumbnail_directory) / "story-thumbnail.jpg"
                    app.state.thumbnail_generator(visible_video, thumbnail)
                    stage = "video_upload_to_story"
                    published = client.video_upload_to_story(visible_video, thumbnail=thumbnail, links=[link])
        except Exception as exc:
            code, message, status = _story_error_code(exc, stage)
            _log_publish_exception(
                exc,
                account_id=body.accountId,
                stage=stage,
                error_code=code,
                credential_record=credential_record,
                failure_category=_story_failure_category(code, stage),
            )
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
            record = app.state.store.load(account_id)
        except CredentialStoreError as exc:
            raise HTTPException(status_code=500, detail={"code": "IG_SESSION_STORE_ERROR"}) from exc
        if record is None:
            logger.info("SESSION_INVALID accountId=%s", account_id)
            return {
                "accountId": account_id,
                "status": "YELLOW",
                "session": "INVALID",
                "sessionStatus": "INVALID",
                "loginState": "LOGIN_REQUIRED",
                "requiresAction": True,
                "proxyConfigured": None,
                "lastError": "IG_LOGIN_REQUIRED",
                "errorCode": "IG_LOGIN_REQUIRED",
            }
        if record.get("lastError") == "IG_2FA_REQUIRED":
            return {
                "accountId": account_id,
                "status": "YELLOW",
                "session": "INVALID",
                "sessionStatus": "INVALID",
                "loginState": "2FA_REQUIRED",
                "requiresAction": True,
                "proxyConfigured": bool(record.get("proxy")),
                "lastError": "IG_2FA_REQUIRED",
                "errorCode": "IG_2FA_REQUIRED",
            }
        try:
            client, record = client_for(account_id)
            client.account_info()
            save_valid_session(account_id, client, record, reused=True)
            return {"accountId": account_id, "status": "GREEN", "session": "VALID", "sessionStatus": "VALID", "loginState": "ACTIVE", "requiresAction": False, "proxyConfigured": bool(record.get("proxy")), "lastError": None, "errorCode": None}
        except HTTPException as exc:
            detail = exc.detail if isinstance(exc.detail, dict) else {}
            code = detail.get("errorCode") or detail.get("code") or "IG_REQUEST_FAILED"
            login_state = {
                "IG_LOGIN_REQUIRED": "LOGIN_REQUIRED",
                "IG_2FA_REQUIRED": "2FA_REQUIRED",
                "IG_CHALLENGE_REQUIRED": "CHALLENGE_REQUIRED",
                "IG_BAD_PASSWORD": "BAD_PASSWORD",
            }.get(code)
            status = "YELLOW" if login_state else "RED"
            return {
                "accountId": account_id,
                "status": status,
                "session": "INVALID",
                "sessionStatus": "INVALID",
                "loginState": login_state or "ERROR",
                "requiresAction": bool(login_state),
                "proxyConfigured": bool(record.get("proxy")) if record else None,
                "lastError": code,
                "errorCode": code,
            }
        except Exception as exc:
            code, _, _ = _error_code(exc)
            login_state = {
                "IG_LOGIN_REQUIRED": "LOGIN_REQUIRED",
                "IG_2FA_REQUIRED": "2FA_REQUIRED",
                "IG_CHALLENGE_REQUIRED": "CHALLENGE_REQUIRED",
                "IG_BAD_PASSWORD": "BAD_PASSWORD",
            }.get(code)
            if code == "IG_LOGIN_REQUIRED":
                logger.warning("SESSION_INVALID accountId=%s", account_id)
            return {
                "accountId": account_id,
                "status": "YELLOW" if login_state else "RED",
                "session": "INVALID",
                "sessionStatus": "INVALID",
                "loginState": login_state or "ERROR",
                "requiresAction": bool(login_state),
                "proxyConfigured": bool(record.get("proxy")) if record else None,
                "lastError": code,
                "errorCode": code,
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
