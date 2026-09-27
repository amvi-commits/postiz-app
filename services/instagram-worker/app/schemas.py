from __future__ import annotations

from typing import Literal
from pydantic import AnyHttpUrl, BaseModel, Field


class LoginRequest(BaseModel):
    accountId: str = Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9_-]+$")
    username: str = Field(min_length=1, max_length=100)
    password: str = Field(min_length=1, max_length=512)
    proxy: str | None = Field(default=None, max_length=2048)
    verificationCode: str | None = Field(default=None, max_length=32)


class AccountIdRequest(BaseModel):
    accountId: str = Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9_-]+$")


class ProxyTestRequest(BaseModel):
    proxy: str = Field(min_length=1, max_length=2048)


class StickerPosition(BaseModel):
    x: float = Field(default=0.5, ge=0, le=1)
    y: float = Field(default=0.5, ge=0, le=1)
    width: float = Field(default=0.51, gt=0, le=1)
    height: float = Field(default=0.26, gt=0, le=1)
    rotation: float = Field(default=0, ge=-360, le=360)


class PublishReelRequest(BaseModel):
    accountId: str = Field(min_length=1, max_length=100)
    videoPath: str = Field(min_length=1, max_length=2048)
    caption: str = Field(default="", max_length=2200)
    thumbnailPath: str | None = Field(default=None, max_length=2048)
    trialReel: bool = False


class PublishStoryRequest(BaseModel):
    accountId: str = Field(min_length=1, max_length=100)
    mediaPath: str = Field(min_length=1, max_length=2048)
    mediaType: Literal["image", "video"]
    linkUrl: AnyHttpUrl
    sticker: StickerPosition = Field(default_factory=StickerPosition)


class PublishResponse(BaseModel):
    mediaId: str
    shortcode: str | None = None
    postUrl: str | None = None
    publishedAt: str
    mediaType: str
