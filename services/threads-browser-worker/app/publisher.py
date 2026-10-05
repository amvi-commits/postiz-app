import time
import uuid
import logging
from typing import Optional
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

def publish_thread(
    account: str,
    text: str,
    is_ghost: bool = False,
    dry_run: bool = False,
    request_id: Optional[str] = None,
) -> PostResponseModel:
    """Execute Threads publishing via Playwright persistent browser profile."""
    # 1. Account existence validation
    if not account_exists(account):
        raise AccountNotFoundError(account)

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

            # 6. Dry run check
            if dry_run:
                logger.info(f"[{account}] dry_run=True: Text entered, skipping post button click.")
                return PostResponseModel(
                    status="dry_run_ok",
                    account=account,
                    request_id=request_id,
                )

            # 7. Ghost post verification
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

            # 8. Submit Post
            submit_btn = _find_post_submit_button(page)
            if not submit_btn:
                save_diagnostic(page, account, "post_button_not_found")
                raise PostButtonNotFoundError("Threads投稿ボタンが見つかりませんでした。")

            logger.info(f"[{account}] Clicking submit button...")
            submit_btn.click()

            # 9. Verify Success Condition (Multiple signals)
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
        except Exception as e:
            if page and not isinstance(e, (AccountNotFoundError, AuthRequiredError, ComposerNotFoundError, PostButtonNotFoundError, GhostNotAvailableError, PostStatusUnknownError, CustomTimeoutError)):
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
