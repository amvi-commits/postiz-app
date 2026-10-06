import pytest
from app.accounts import (
    account_exists,
    get_account_profile_dir,
    list_accounts,
    acquire_account_lock,
)
from app.errors import AccountBusyError

def test_account_creation_and_listing(tmp_path, monkeypatch):
    from app.config import settings
    monkeypatch.setattr(settings, "SESSIONS_DIR", tmp_path)

    # Empty initially
    assert list_accounts() == []
    assert not account_exists("account_a")

    # Create account A and B
    get_account_profile_dir("account_a", create=True)
    get_account_profile_dir("account_b", create=True)

    # A hidden or lock file should not be listed as an account
    (tmp_path / ".account_a.lock").touch()
    (tmp_path / ".hidden_dir").mkdir()

    accounts = list_accounts()
    assert len(accounts) == 2
    names = [a.name for a in accounts]
    assert "account_a" in names
    assert "account_b" in names
    assert account_exists("account_a")
    assert account_exists("account_b")
    assert not account_exists("non_existent")

def test_account_concurrency_lock(tmp_path, monkeypatch):
    from app.config import settings
    monkeypatch.setattr(settings, "SESSIONS_DIR", tmp_path)

    get_account_profile_dir("locked_user", create=True)

    # Lock once
    with acquire_account_lock("locked_user", timeout=0.1):
        # Attempt to lock the same account concurrently with short timeout
        with pytest.raises(AccountBusyError) as exc_info:
            with acquire_account_lock("locked_user", timeout=0.05):
                pass
        assert exc_info.value.code == "ACCOUNT_BUSY"

    # After exiting the outer context, the lock can be acquired again
    with acquire_account_lock("locked_user", timeout=0.1):
        pass
