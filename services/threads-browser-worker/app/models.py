import re
from typing import Literal, Optional, List
from urllib.parse import urlparse
from pydantic import BaseModel, Field, field_validator, model_validator
from app.errors import InvalidAccountNameError

ACCOUNT_NAME_REGEX = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
ALLOWED_MEDIA_EXTENSIONS = (".jpg", ".jpeg", ".png", ".webp")
MAX_MEDIA_ITEMS = 10

class HealthResponse(BaseModel):
    status: str = "ok"
    playwright: bool = True

class AccountInfo(BaseModel):
    name: str
    profile_exists: bool

class AccountsResponse(BaseModel):
    accounts: list[AccountInfo]

class SessionCheckRequest(BaseModel):
    account: str = Field(..., description="Account identifier name")

    @field_validator("account")
    @classmethod
    def validate_account(cls, v: str) -> str:
        v = v.strip()
        if not ACCOUNT_NAME_REGEX.match(v) or ".." in v or "/" in v or "\\" in v or ":" in v:
            raise InvalidAccountNameError(v)
        return v

class SessionCheckResponse(BaseModel):
    account: str
    status: Literal["SESSION_OK", "AUTH_REQUIRED", "SESSION_UNKNOWN"]

class AccountProfileResponse(BaseModel):
    account: str
    status: Literal["SESSION_OK", "AUTH_REQUIRED", "SESSION_UNKNOWN"]
    username: Optional[str] = None
    displayName: Optional[str] = None
    profileUrl: Optional[str] = None
    picture: Optional[str] = None

class PostRequest(BaseModel):
    account: str = Field(..., description="Account identifier name")
    text: str = Field(..., description="Post message text (1-500 characters)")
    is_ghost: bool = Field(default=False, description="Whether this is an ephemeral ghost post")
    request_id: Optional[str] = Field(default=None, description="Client request ID for correlation")
    dry_run: bool = Field(default=False, description="Simulate text entry without clicking post button")
    media_urls: Optional[List[str]] = Field(default=None, description="添付する画像URLのリスト")
    media_paths: Optional[List[str]] = Field(default=None, description="ローカル/ボリューム上の画像ファイルパスのリスト")

    @field_validator("account")
    @classmethod
    def validate_account(cls, v: str) -> str:
        v = v.strip()
        if not ACCOUNT_NAME_REGEX.match(v) or ".." in v or "/" in v or "\\" in v or ":" in v:
            raise InvalidAccountNameError(v)
        return v

    @field_validator("text")
    @classmethod
    def validate_text(cls, v: str) -> str:
        trimmed = v.strip()
        if not trimmed:
            raise ValueError("Post text cannot be empty or only whitespace.")
        if len(trimmed) > 500:
            raise ValueError(f"Post text length ({len(trimmed)}) exceeds Threads limit of 500 characters.")
        return trimmed

    @field_validator("media_urls", "media_paths")
    @classmethod
    def validate_media_extensions(cls, v: Optional[List[str]]) -> Optional[List[str]]:
        if not v:
            return v
        for item in v:
            item_clean = item.strip()
            if not item_clean:
                raise ValueError("Media item cannot be empty string.")
            parsed_path = urlparse(item_clean).path.lower() if "://" in item_clean else item_clean.lower()
            if not any(parsed_path.endswith(ext) for ext in ALLOWED_MEDIA_EXTENSIONS):
                raise ValueError(
                    f"Unsupported media format in '{item}'. Allowed extensions: {', '.join(ALLOWED_MEDIA_EXTENSIONS)}"
                )
        return v

    @model_validator(mode="after")
    def validate_total_media_count(self) -> "PostRequest":
        urls = self.media_urls or []
        paths = self.media_paths or []
        total = len(urls) + len(paths)
        if total > MAX_MEDIA_ITEMS:
            raise ValueError(f"Total media items ({total}) exceeds Threads maximum limit of {MAX_MEDIA_ITEMS}.")
        return self

class PostResponseModel(BaseModel):
    status: str = "ok"  # "ok" or "dry_run_ok"
    account: str
    post_id: Optional[str] = None
    request_id: Optional[str] = None
    url: Optional[str] = None

class ErrorResponse(BaseModel):
    status: str = "error"
    code: str
    message: str
    request_id: Optional[str] = None
