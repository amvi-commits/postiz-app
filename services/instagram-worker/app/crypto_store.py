from __future__ import annotations

import json
import os
import re
import secrets
from pathlib import Path
from typing import Any

from cryptography.fernet import Fernet, InvalidToken


class CredentialStoreError(Exception):
    pass


class CredentialStore:
    """Encrypts Instagram credentials and session settings at rest."""

    def __init__(self, data_dir: Path, key: str | None = None):
        self.data_dir = data_dir
        self.data_dir.mkdir(parents=True, exist_ok=True)
        configured_key = key or os.getenv("IG_CREDENTIALS_KEY")
        if configured_key:
            self._fernet = Fernet(configured_key.encode("ascii"))
        else:
            self._fernet = Fernet(self._load_or_create_key())

    def _load_or_create_key(self) -> bytes:
        key_path = self.data_dir / ".credentials.key"
        try:
            fd = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            return key_path.read_bytes().strip()
        key = Fernet.generate_key()
        with os.fdopen(fd, "wb") as key_file:
            key_file.write(key + b"\n")
            key_file.flush()
            os.fsync(key_file.fileno())
        return key

    @staticmethod
    def _safe_id(account_id: str) -> str:
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", account_id):
            raise CredentialStoreError("Invalid account id")
        return account_id

    def _path(self, account_id: str) -> Path:
        return self.data_dir / f"{self._safe_id(account_id)}.enc"

    def save(self, account_id: str, value: dict[str, Any]) -> None:
        target = self._path(account_id)
        encrypted = self._fernet.encrypt(
            json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        )
        temporary = target.with_suffix(".enc.tmp")
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as data_file:
            data_file.write(encrypted)
            data_file.flush()
            os.fsync(data_file.fileno())
        os.replace(temporary, target)

    def load(self, account_id: str) -> dict[str, Any] | None:
        path = self._path(account_id)
        if not path.exists():
            return None
        try:
            decrypted = self._fernet.decrypt(path.read_bytes())
            value = json.loads(decrypted)
        except (InvalidToken, json.JSONDecodeError, OSError) as exc:
            raise CredentialStoreError("Stored credentials could not be decrypted") from exc
        if not isinstance(value, dict):
            raise CredentialStoreError("Stored credentials have an invalid format")
        return value

    def delete(self, account_id: str) -> None:
        self._path(account_id).unlink(missing_ok=True)

