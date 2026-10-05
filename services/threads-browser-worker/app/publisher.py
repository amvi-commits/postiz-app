import os
import re
import shutil
import socket
import ipaddress
import tempfile
import time
import uuid
import logging
from typing import Optional, List
from urllib.parse import urlparse, urljoin
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
    GhostStateUnknownError,
    PostSubmitFailedError,
    PostStatusUnknownError,
    MediaUploadFailedError,
    MediaTooLargeError,
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
    GHOST_TOGGLE_LABELS,
    GHOST_TOGGLE_SELECTORS,
    POST_VIEW_LINK_SELECTORS,
    SUCCESS_TOAST_SELECTORS,
    ATTACH_MEDIA_LABELS,
    ATTACH_MEDIA_SELECTORS,
    FILE_INPUT_SELECTORS,
    MEDIA_PREVIEW_SELECTORS,
    MEDIA_UPLOAD_PROGRESS_SELECTORS,
)

logger = logging.getLogger(__name__)

def _validate_media_url_ssrf(url: str) -> None:
    """Validate URL scheme, host, and resolved IP against SSRF attacks."""
    parsed = urlparse(url)
    scheme = parsed.scheme.lower()
    if scheme not in ("http", "https"):
        raise InvalidMediaError(f"無効なURLスキームです: '{scheme}'. http または https のみ許可されています。")

    if parsed.username or parsed.password:
        raise InvalidMediaError("URLにユーザー名またはパスワードを含めることはできません。")

    hostname = parsed.hostname
    if not hostname:
        raise InvalidMediaError("URLにホスト名が含まれていません。")

    port = parsed.port or (443 if scheme == "https" else 80)
    host_with_port = f"{hostname}:{port}"

    # Check allowed local hosts allowlist
    allowed_hosts = [h.lower() for h in settings.MEDIA_ALLOWED_HOSTS]
    if hostname.lower() in allowed_hosts or host_with_port.lower() in allowed_hosts:
        return

    # Resolve DNS to check IP addresses
    try:
        addr_info = socket.getaddrinfo(hostname, port, socket.AF_UNSPEC, socket.SOCK_STREAM)
    except socket.gaierror as e:
        raise InvalidMediaError(f"ホスト名を解決できませんでした: {hostname} ({e})")

    for family, socktype, proto, canonname, sockaddr in addr_info:
        ip_str = sockaddr[0]
        try:
            ip_obj = ipaddress.ip_address(ip_str)
        except ValueError:
            continue

        if (
            ip_obj.is_private
            or ip_obj.is_loopback
            or ip_obj.is_link_local
            or ip_obj.is_multicast
            or ip_obj.is_reserved
            or ip_obj.is_unspecified
        ):
            raise InvalidMediaError(
                f"プライベートまたは制限されたIPアドレス範囲へのアクセスは禁止されています: {hostname} ({ip_str})"
            )


def _download_media_file_safe(url: str, dest_path: str) -> None:
    """Download media URL safely with SSRF validation on redirects, MIME check, and size limit."""
    current_url = url
    redirect_count = 0
    MAX_REDIRECTS = 3

    while redirect_count <= MAX_REDIRECTS:
        _validate_media_url_ssrf(current_url)

        with httpx.Client(timeout=30.0, follow_redirects=False) as client:
            try:
                with client.stream("GET", current_url, headers={"User-Agent": "PostizThreadsSidecar/1.0"}) as resp:
                    if resp.status_code in (301, 302, 303, 307, 308):
                        location = resp.headers.get("Location")
                        if not location:
                            raise MediaUploadFailedError("リダイレクト先にLocationヘッダーがありません。")
                        current_url = urljoin(current_url, location)
                        redirect_count += 1
                        if redirect_count > MAX_REDIRECTS:
                            raise MediaUploadFailedError("リダイレクト回数が上限 (3回) を超えました。")
                        continue

                    if resp.status_code != 200:
                        raise MediaUploadFailedError(
                            f"メディアURLのダウンロードに失敗しました (HTTP {resp.status_code})"
                        )

                    headers_lower = {k.lower(): v for k, v in resp.headers.items()}
                    content_type = headers_lower.get("content-type", "").split(";")[0].strip().lower()
                    if content_type not in ("image/jpeg", "image/png", "image/webp"):
                        raise InvalidMediaError(
                            f"無効なContent-Typeです: '{content_type}'. 許可されているMIMEタイプ: image/jpeg, image/png, image/webp"
                        )

                    content_length = headers_lower.get("content-length")
                    if content_length and int(content_length) > settings.MEDIA_MAX_BYTES:
                        raise MediaTooLargeError(
                            f"メディアサイズが上限 ({settings.MEDIA_MAX_BYTES} bytes) を超えています。"
                        )

                    total_downloaded = 0
                    with open(dest_path, "wb") as f:
                        for chunk in resp.iter_bytes(chunk_size=65536):
                            total_downloaded += len(chunk)
                            if total_downloaded > settings.MEDIA_MAX_BYTES:
                                raise MediaTooLargeError(
                                    f"メディアサイズが上限 ({settings.MEDIA_MAX_BYTES} bytes) を超えています。"
                                )
                            f.write(chunk)
                    return
            except (InvalidMediaError, MediaTooLargeError, MediaUploadFailedError):
                if os.path.exists(dest_path):
                    try:
                        os.remove(dest_path)
                    except OSError:
                        pass
                raise
            except Exception as e:
                if os.path.exists(dest_path):
                    try:
                        os.remove(dest_path)
                    except OSError:
                        pass
                raise MediaUploadFailedError(f"メディアURLのダウンロード中に通信エラーが発生しました: {e}")


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

    # 2. Download media URLs with SSRF protection and sanitized logging
    if media_urls:
        for idx, url in enumerate(media_urls):
            parsed = urlparse(url)
            host = parsed.hostname or "unknown"
            ext = os.path.splitext(parsed.path)[1].lower() or ".jpg"
            # Sanitize log output (no query tokens/credentials)
            logger.info(f"Downloading media item {idx + 1}/{len(media_urls)}: host={host}, ext={ext}")

            dest_path = os.path.join(temp_dir, f"media_upload_{idx}_{uuid.uuid4().hex[:6]}{ext}")
            _download_media_file_safe(url, dest_path)
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


def _toggle_and_verify_ghost_mode(page: Page) -> bool:
    """Locate Ghost Post toggle in composer, click it, and verify that it entered ghost mode."""
    toggle_el = None
    # 1. Search by label
    for label in GHOST_TOGGLE_LABELS:
        loc = page.get_by_label(label)
        if loc.count() > 0 and loc.first.is_visible():
            toggle_el = loc.first
            break

    # 2. Search by selectors
    if not toggle_el:
        for sel in GHOST_TOGGLE_SELECTORS:
            loc = page.locator(sel)
            if loc.count() > 0 and loc.first.is_visible():
                toggle_el = loc.first
                break

    if not toggle_el:
        raise GhostNotAvailableError("Threads Web UI上にGhost Postの操作UIが存在しないため、送信できません。")

    # Click the toggle
    toggle_el.click()
    page.wait_for_timeout(500)

    # Verify toggle state changed to active/checked
    is_verified = False
    try:
        aria_checked = toggle_el.get_attribute("aria-checked")
        aria_pressed = toggle_el.get_attribute("aria-pressed")
        data_state = toggle_el.get_attribute("data-state")
        class_attr = toggle_el.get_attribute("class") or ""
        if (
            aria_checked in ("true", "1")
            or aria_pressed in ("true", "1")
            or data_state == "checked"
            or "checked" in class_attr
            or "active" in class_attr
        ):
            is_verified = True
    except Exception:
        pass

    if not is_verified:
        raise GhostStateUnknownError("Ghost Postトグルをクリックしましたが、有効化状態を確認できませんでした。")

    logger.info("Ghost post mode toggled and verified on composer.")
    return True


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

                # 7. Ghost post toggle and verification
                if is_ghost:
                    logger.info(f"[{account}] Activating and verifying Ghost post mode...")
                    _toggle_and_verify_ghost_mode(page)

                # 8. Dry run check
                if dry_run:
                    logger.info(f"[{account}] dry_run=True: Text, media, and ghost state verified, skipping post button click.")
                    return PostResponseModel(
                        status="dry_run_ok",
                        account=account,
                        request_id=request_id,
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

                # 11. Extract real permalink / identifier if present in UI
                real_url: Optional[str] = None
                real_post_id: Optional[str] = None

                for sel in POST_VIEW_LINK_SELECTORS:
                    link_loc = page.locator(sel)
                    if link_loc.count() > 0:
                        try:
                            href = link_loc.first.get_attribute("href")
                            if href and ("threads.net" in href or href.startswith("/")):
                                full_href = href if href.startswith("http") else f"{THREADS_BASE_URL}{href}"
                                match = re.search(r"/(?:post|t)/([A-Za-z0-9_-]+)", full_href)
                                if match:
                                    real_url = full_href
                                    real_post_id = match.group(1)
                                    break
                        except Exception:
                            pass

                if real_post_id and real_url:
                    logger.info(f"[{account}] Successfully published thread with real ID: {real_post_id}, URL: {real_url}")
                    return PostResponseModel(
                        status="ok",
                        account=account,
                        post_id=real_post_id,
                        url=real_url,
                        request_id=request_id,
                    )
                else:
                    # Success verified via modal closing / toast, but specific permalink could not be scraped from UI.
                    # DO NOT generate fake IDs or fake profile permalinks!
                    logger.info(f"[{account}] Thread submission confirmed in UI, but specific permalink not exposed. Returning status='submitted' without synthetic IDs.")
                    return PostResponseModel(
                        status="submitted",
                        account=account,
                        post_id=None,
                        url=None,
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
            except GhostStateUnknownError:
                if page:
                    save_diagnostic(page, account, "ghost_state_unknown")
                raise
            except GhostNotAvailableError:
                if page:
                    save_diagnostic(page, account, "ghost_not_available")
                raise
            except Exception as e:
                if page and not isinstance(e, (AccountNotFoundError, AuthRequiredError, ComposerNotFoundError, PostButtonNotFoundError, GhostNotAvailableError, GhostStateUnknownError, PostStatusUnknownError, CustomTimeoutError, MediaUploadFailedError, MediaTooLargeError, InvalidMediaError)):
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
