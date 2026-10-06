import re
from pathlib import Path
from contextlib import contextmanager
from filelock import FileLock, Timeout
from app.config import settings
from app.errors import AccountNotFoundError, AccountBusyError, InvalidAccountNameError
from app.models import AccountInfo

ACCOUNT_NAME_REGEX = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

def validate_account_name(account: str) -> str:
    """Validate account name against allowed alphanumeric, dash, and underscore characters.
    Disallows path traversal sequences explicitly.
    """
    cleaned = (account or "").strip()
    if not cleaned or not ACCOUNT_NAME_REGEX.match(cleaned):
        raise InvalidAccountNameError(account)
    if ".." in cleaned or "/" in cleaned or "\\" in cleaned or ":" in cleaned:
        raise InvalidAccountNameError(account)
    return cleaned

def get_account_profile_dir(account: str, create: bool = False) -> Path:
    """Resolve and verify canonical profile path within sessions_dir to prevent path traversal."""
    valid_name = validate_account_name(account)
    sessions_root = settings.SESSIONS_DIR.resolve()
    target_dir = (sessions_root / valid_name).resolve()

    # Canonical path traversal defense
    try:
        target_dir.relative_to(sessions_root)
    except ValueError:
        raise InvalidAccountNameError(account)

    if create:
        target_dir.mkdir(parents=True, exist_ok=True)

    return target_dir

def account_exists(account: str) -> bool:
    """Check if account profile directory exists."""
    try:
        profile_dir = get_account_profile_dir(account, create=False)
        return profile_dir.is_dir()
    except (InvalidAccountNameError, ValueError):
        return False

def list_accounts() -> list[AccountInfo]:
    """List all configured accounts in the sessions directory."""
    sessions_root = settings.SESSIONS_DIR.resolve()
    if not sessions_root.exists():
        return []

    accounts = []
    for item in sorted(sessions_root.iterdir()):
        if item.is_dir() and ACCOUNT_NAME_REGEX.match(item.name) and not item.name.startswith("."):
            accounts.append(
                AccountInfo(
                    name=item.name,
                    profile_exists=True,
                )
            )
    return accounts

@contextmanager
def acquire_account_lock(account: str, timeout: float = 0.5):
    """Context manager to acquire a process-level file lock for a specific account.
    Prevents concurrent Chromium instances from corrupting the same browser profile.
    """
    valid_name = validate_account_name(account)
    sessions_root = settings.SESSIONS_DIR.resolve()
    lock_file = sessions_root / f".{valid_name}.lock"

    lock = FileLock(str(lock_file), timeout=timeout)
    try:
        lock.acquire()
        yield
    except Timeout:
        raise AccountBusyError(account)
    finally:
        if lock.is_locked:
            lock.release()
