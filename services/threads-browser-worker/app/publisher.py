import os
import shutil
import tempfile
import time
import uuid
import logging
from typing import Optional, List
from urllib.parse import urlparse
import httpx
from playwright.sync_api import Page, TimeoutError as PlaywrightTimeoutError

from app.config import settings
from app.accounts import account_exists, acquire_account_lock
from app.browser import launch_persistent_browser, check_login_state, save_diagnostic
from app.errors import (
    AccountNotFoundError,
    AuthRequiredError,
    ComposerNotFoundError,
    PostButtonNotFoundError,
    GhostNotAvailableError,
    PostSubmitFailedError,
    PostStatusUnknownError,
    MediaUploadFailedError,
    InvalidMediaError,
    TimeoutError as CustomTimeoutError,
)
from app.models import PostResponseModel
from app.selectors import (
    THREADS_BASE_URL,
    COMPOSER_BUTTON_NAMES,
    COMPOSER_ARIA_LABELS,
    COMPOSER_FALLBACK_SELECTORS,
    COMPOSER_TEXTBOX_NAMES,
    COMPOSER_TEXTBOX_SELECTORS,
    POST_SUBMIT_BUTTON_NAMES,
    POST_SUBMIT_SELECTORS,
    GHOST_UI_KEYWORDS,
    SUCCESS_TOAST_SELECTORS,
    ATTACH_MEDIA_LABELS,
    ATTACH_MEDIA_SELECTORS,
    FILE_INPUT_SELECTORS,
    MEDIA_PREVIEW_SELECTORS,
    MEDIA_UPLOAD_PROGRESS_SELECTORS,
)

logger = logging.getLogger(__name__)

def _find_and_open_composer(page: Page) -> bool:
    """Attempt to locate and click the thread composer button using prioritize locator strategies."""
    # 1. get_by_role
    for name in COMPOSER_BUTTON_NAMES:
        locator = page.get_by_role("button", name=name)
        if locator.count() > 0 and locator.first.is_visible():
            locator.first.click()
            return True

    # 2. get_by_label
    for label in COMPOSER_ARIA_LABELS:
        locator = page.get_by_label(label)
        if locator.count() > 0 and locator.first.is_visible():
            locator.first.click()
            return True

    # 3. Fallback selectors
    for sel in COMPOSER_FALLBACK_SELECTORS:
        locator = page.locator(sel)
        if locator.count() > 0 and locator.first.is_visible():
            locator.first.click()
            return True

    return False

def _find_composer_textbox(page: Page):
    """Find the active editable textbox inside the thread composer."""
    # 1. Try role textbox with candidate names
    for name in COMPOSER_TEXTBOX_NAMES:
        loc = page.get_by_role("textbox", name=name)
        if loc.count() > 0 and loc.first.is_visible():
            return loc.first

    # 2. Try contenteditable div selectors
    for sel in COMPOSER_TEXTBOX_SELECTORS:
        loc = page.locator(sel)
        if loc.count() > 0 and loc.first.is_visible():
            return loc.first

    return None

def _find_post_submit_button(page: Page):
    """Find the submit button in the composer."""
    for name in POST_SUBMIT_BUTTON_NAMES:
        loc = page.get_by_role("button", name=name)
        if loc.count() > 0 and loc.first.is_visible():
            return loc.first

    for sel in POST_SUBMIT_SELECTORS:
        loc = page.locator(sel)
        if loc.count() > 0 and loc.first.is_visible():
            return loc.first

    return None

def _prepare_media_files(
    media_urls: Optional[List[str]],
    media_paths: Optional[List[str]],
    temp_dir: str,
) -> List[str]:
    """Download URLs and validate local paths, returning list of absolute file paths to attach."""
    prepared_files: List[str] = []

    # 1. Validate local media paths
    if media_paths:
        for p in media_paths:
            abs_p = os.path.abspath(p)
            if not os.path.exists(abs_p) or not os.path.isfile(abs_p):
                raise InvalidMediaError(f"指定されたメディアファイルが存在しません: {p}")
            prepared_files.append(abs_p)

    # 2. Download media URLs
    if media_urls:
        for idx, url in enumerate(media_urls):
            logger.info(f"Downloading media item {idx + 1}/{len(media_urls)}: {url}...")
            parsed = urlparse(url)
            ext = os.path.splitext(parsed.path)[1].lower()
            if not ext:
                ext = ".jpg"

            dest_path = os.path.join(temp_dir, f"media_upload_{idx}_{uuid.uuid4().hex[:6]}{ext}")
            try:
                with httpx.Client(timeout=30.0, follow_redirects=True) as client:
                    resp = client.get(url)
                    if resp.status_code != 200:
                        raise MediaUploadFailedError(
                            f"メディアURLのダウンロードに失敗しました (HTTP {resp.status_code}): {url}"
                        )
                    with open(dest_path, "wb") as f:
                        f.write(resp.content)
            except Exception as e:
                if isinstance(e, MediaUploadFailedError):
                    raise
                raise MediaUploadFailedError(f"メディアURLのダウンロード中に通信エラーが発生しました: {url} ({e})")

            prepared_files.append(os.path.abspath(dest_path))

    return prepared_files


def _attach_media_files(page: Page, file_paths: List[str]) -> None:
    """Attach media files to composer via file input or file chooser."""
    if not file_paths:
        return

    # First attempt: directly set input files on any matching file inputs
    for sel in FILE_INPUT_SELECTORS:
        loc = page.locator(sel)
        if loc.count() > 0:
            logger.info(f"Setting {len(file_paths)} files via selector '{sel}'...")
            loc.first.set_input_files(file_paths)
            return

    # Second attempt: file chooser triggered by attach button
    logger.info("File input not found directly; searching attach media button...")
    attach_btn = None
    for label in ATTACH_MEDIA_LABELS:
        loc = page.get_by_label(label)
        if loc.count() > 0 and loc.first.is_visible():
            attach_btn = loc.first
            break

    if not attach_btn:
        for sel in ATTACH_MEDIA_SELECTORS:
            loc = page.locator(sel)
            if loc.count() > 0 and loc.first.is_visible():
                attach_btn = loc.first
                break

    if not attach_btn:
        raise MediaUploadFailedError("メディア添付ボタンまたはファイル入力要素が見つかりませんでした。")

    logger.info("Triggering file chooser via attach media button click...")
    with page.expect_file_chooser(timeout=10000) as fc_info:
        attach_btn.click()
    file_chooser = fc_info.value
    file_chooser.set_files(file_paths)


def _wait_for_media_upload(page: Page, timeout_sec: float = 15.0) -> None:
    """Wait for media upload completion (preview visible, loading indicator disappeared)."""
    start_wait = time.time()
    preview_found = False

    # Short wait to allow upload initiation
    page.wait_for_timeout(1000)

    while time.time() - start_wait < timeout_sec:
        # Check if progress/loading indicator is active
        has_progress = False
        for prog_sel in MEDIA_UPLOAD_PROGRESS_SELECTORS:
            loc = page.locator(prog_sel)
            if loc.count() > 0 and loc.first.is_visible():
                has_progress = True
                break

        # Check if preview element is present
        for prev_sel in MEDIA_PREVIEW_SELECTORS:
            loc = page.locator(prev_sel)
            if loc.count() > 0 and loc.first.is_visible():
                preview_found = True
                break

        if preview_found and not has_progress:
            logger.info("Media upload completed and preview verified.")
            return

        page.wait_for_timeout(500)

    if not preview_found:
        raise MediaUploadFailedError("メディアのアップロード処理がタイムアウトしました（プレビュー未確認）。")


def publish_thread(
    account: str,
    text: str,
    media_urls: Optional[List[str]] = None,
    media_paths: Optional[List[str]] = None,
    is_ghost: bool = False,
    dry_run: bool = False,
    request_id: Optional[str] = None,
) -> PostResponseModel:
    """Execute Threads publishing via Playwright persistent browser profile."""
    # 1. Account existence validation
    if not account_exists(account):
        raise AccountNotFoundError(account)

    temp_dir = tempfile.mkdtemp(prefix="threads_media_")
    try:
        # Prepare media files if any
        has_media = bool(media_urls or media_paths)
        file_paths = []
        if has_media:
            file_paths = _prepare_media_files(media_urls, media_paths, temp_dir)

        # 2. Acquire profile lock (single concurrent process per account)
        with acquire_account_lock(account):
            pw, context = launch_persistent_browser(account)
            page: Optional[Page] = None
            try:
                page = context.pages[0] if context.pages else context.new_page()
                page.set_default_timeout(settings.TIMEOUT_MS)

                # 3. Open Threads and verify login state
                logger.info(f"[{account}] Opening Threads home...")
                page.goto(THREADS_BASE_URL, wait_until="domcontentloaded")
                page.wait_for_timeout(1500)

                login_state = check_login_state(page)
                if login_state == "AUTH_REQUIRED":
                    save_diagnostic(page, account, "auth_required")
                    raise AuthRequiredError("Threadsへの再ログインが必要です。セッションが切断されています。")

                # 4. Open Composer
                logger.info(f"[{account}] Opening post composer...")
                opened = _find_and_open_composer(page)
                page.wait_for_timeout(800)

                # Locate editable text area
                textbox = _find_composer_textbox(page)
                if not textbox:
                    save_diagnostic(page, account, "composer_not_found")
                    raise ComposerNotFoundError("Threads投稿コンポーザーが見つかりませんでした。")

                # 5. Fill message text
                logger.info(f"[{account}] Entering text into composer (length: {len(text)})...")
                textbox.click()
                textbox.fill(text)
                page.wait_for_timeout(500)

                # 6. Attach media if provided
                if has_media and file_paths:
                    logger.info(f"[{account}] Attaching {len(file_paths)} media files...")
                    _attach_media_files(page, file_paths)
                    _wait_for_media_upload(page, timeout_sec=15.0)
                    page.wait_for_timeout(500)

                # 7. Dry run check
                if dry_run:
                    logger.info(f"[{account}] dry_run=True: Text and media verified, skipping post button click.")
                    return PostResponseModel(
                        status="dry_run_ok",
                        account=account,
                        request_id=request_id,
                    )

                # 8. Ghost post verification
                if is_ghost:
                    ghost_found = False
                    for keyword in GHOST_UI_KEYWORDS:
                        if page.locator(f"text={keyword}").count() > 0:
                            ghost_found = True
                            break
                    if not ghost_found:
                        save_diagnostic(page, account, "ghost_not_available")
                        raise GhostNotAvailableError(
                            "Threads Web UI上にGhost Postのネイティブ操作UIが存在しないため、送信できません。"
                        )

                # 9. Submit Post
                submit_btn = _find_post_submit_button(page)
                if not submit_btn:
                    save_diagnostic(page, account, "post_button_not_found")
                    raise PostButtonNotFoundError("Threads投稿ボタンが見つかりませんでした。")

                logger.info(f"[{account}] Clicking submit button...")
                submit_btn.click()

                # 10. Verify Success Condition (Multiple signals)
                success_verified = False
                start_wait = time.time()
                while time.time() - start_wait < 15:
                    # Signal A: Textbox / composer dialog closes
                    if not textbox.is_visible():
                        success_verified = True
                        break

                    # Signal B: Success toast notification appears
                    for toast_sel in SUCCESS_TOAST_SELECTORS:
                        if page.locator(toast_sel).count() > 0 and page.locator(toast_sel).first.is_visible():
                            success_verified = True
                            break
                    if success_verified:
                        break

                    page.wait_for_timeout(500)

                if not success_verified:
                    save_diagnostic(page, account, "post_status_unknown")
                    raise PostStatusUnknownError("投稿ボタンを押下しましたが、完了シグナル（モーダル消去・通知）を確認できませんでした。")

                post_id = f"th_sidecar_{uuid.uuid4().hex[:12]}"
                release_url = f"https://www.threads.net/@{account}"
                logger.info(f"[{account}] Successfully published thread. ID: {post_id}")

                return PostResponseModel(
                    status="ok",
                    account=account,
                    post_id=post_id,
                    url=release_url,
                    request_id=request_id,
                )

            except PlaywrightTimeoutError as e:
                if page:
                    save_diagnostic(page, account, "timeout")
                raise CustomTimeoutError(f"Threadsブラウザ操作がタイムアウトしました: {e}")
            except MediaUploadFailedError:
                if page:
                    save_diagnostic(page, account, "media_upload_failed")
                raise
            except Exception as e:
                if page and not isinstance(e, (AccountNotFoundError, AuthRequiredError, ComposerNotFoundError, PostButtonNotFoundError, GhostNotAvailableError, PostStatusUnknownError, CustomTimeoutError, MediaUploadFailedError, InvalidMediaError)):
                    save_diagnostic(page, account, "internal_failure")
                raise
            finally:
                try:
                    context.close()
                except Exception:
                    pass
                try:
                    pw.stop()
                except Exception:
                    pass
    finally:
        if temp_dir and os.path.exists(temp_dir):
            shutil.rmtree(temp_dir, ignore_errors=True)
