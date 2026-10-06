import pytest
from pydantic import ValidationError
from app.accounts import validate_account_name, get_account_profile_dir
from app.errors import InvalidAccountNameError
from app.models import PostRequest, SessionCheckRequest

def test_validate_account_name_valid():
    assert validate_account_name("main") == "main"
    assert validate_account_name("account_123") == "account_123"
    assert validate_account_name("test-user_01") == "test-user_01"
    assert validate_account_name("A" * 64) == "A" * 64

def test_validate_account_name_invalid_characters():
    invalid_cases = [
        "",
        "   ",
        "../traversal",
        "..",
        "foo/bar",
        "foo\\bar",
        "user:admin",
        "user.name",
        "user@example",
        "user name",
        "A" * 65,  # Exceeds 64 chars
    ]
    for case in invalid_cases:
        with pytest.raises(InvalidAccountNameError):
            validate_account_name(case)

def test_path_traversal_defense(tmp_path, monkeypatch):
    from app.config import settings
    monkeypatch.setattr(settings, "SESSIONS_DIR", tmp_path)

    # Valid account inside sessions
    target = get_account_profile_dir("valid_user")
    assert str(target).startswith(str(tmp_path.resolve()))

    # Direct traversal attempt
    with pytest.raises(InvalidAccountNameError):
        get_account_profile_dir("../outside")

    with pytest.raises(InvalidAccountNameError):
        get_account_profile_dir("..\\outside")

def test_post_request_validation():
    # Valid model
    req = PostRequest(account="main", text="Hello Threads!")
    assert req.account == "main"
    assert req.text == "Hello Threads!"
    assert req.is_ghost is False
    assert req.dry_run is False

    # Empty text
    with pytest.raises(ValidationError):
        PostRequest(account="main", text="")

    # Whitespace-only text
    with pytest.raises(ValidationError):
        PostRequest(account="main", text="    ")

    # Text exceeding 500 characters
    with pytest.raises(ValidationError):
        PostRequest(account="main", text="X" * 501)

    # Text at exactly 500 characters
    req500 = PostRequest(account="main", text="X" * 500)
    assert len(req500.text) == 500

    # Invalid account in request
    with pytest.raises((ValidationError, InvalidAccountNameError)):
        PostRequest(account="../evil", text="Hello")

def test_session_check_request_validation():
    req = SessionCheckRequest(account="safe_account")
    assert req.account == "safe_account"

    with pytest.raises((ValidationError, InvalidAccountNameError)):
        SessionCheckRequest(account="../bad_account")
