from __future__ import annotations

import os
from typing import Protocol

import httpx


class TTSProvider(Protocol):
    def list_voices(self) -> list[dict]: ...
    def synthesize(self, text: str, voice_id: str) -> bytes: ...


class VoicevoxTTSProvider:
    def __init__(self, base_url: str | None = None):
        self.base_url = (base_url or os.getenv("VOICEVOX_URL", "http://voicevox:50021")).rstrip("/")

    def list_voices(self) -> list[dict]:
        response = httpx.get(f"{self.base_url}/speakers", timeout=10)
        response.raise_for_status()
        data = response.json()
        return data if isinstance(data, list) else []

    def synthesize(self, text: str, voice_id: str) -> bytes:
        query = httpx.post(f"{self.base_url}/audio_query", params={"text": text, "speaker": int(voice_id)}, timeout=60)
        query.raise_for_status()
        audio = httpx.post(f"{self.base_url}/synthesis", params={"speaker": int(voice_id)}, json=query.json(), timeout=180)
        audio.raise_for_status()
        return audio.content


def get_tts_provider() -> TTSProvider:
    # Select by SNS_STUDIO_TTS_PROVIDER once additional adapters are configured.
    if os.getenv("SNS_STUDIO_TTS_PROVIDER", "voicevox").lower() != "voicevox":
        raise RuntimeError("Configured TTS provider is unavailable")
    return VoicevoxTTSProvider()
