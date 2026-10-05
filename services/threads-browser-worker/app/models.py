import re
from typing import Literal, Optional
from pydantic import BaseModel, Field, field_validator
from app.errors import InvalidAccountNameError

ACCOUNT_NAME_REGEX = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

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

class PostRequest(BaseModel):
    account: str = Field(..., description="Account identifier name")
    text: str = Field(..., description="Post message text (1-500 characters)")
    is_ghost: bool = Field(default=False, description="Whether this is an ephemeral ghost post")
    request_id: Optional[str] = Field(default=None, description="Client request ID for correlation")
    dry_run: bool = Field(default=False, description="Simulate text entry without clicking post button")

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
