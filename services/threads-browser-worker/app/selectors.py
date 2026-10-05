"""UI Selectors and candidate locators for Threads Web UI.

Priority Strategy:
1. role + name (get_by_role)
2. label (get_by_label)
3. accessible name
4. visible text
5. stable attributes (e.g. data-* or svg aria-label)
6. fallback CSS selectors
"""

# Base URL
THREADS_BASE_URL = "https://www.threads.net"
THREADS_LOGIN_URL = "https://www.threads.net/login"

# Composer open triggers (navigation bar or quick post bar)
COMPOSER_BUTTON_NAMES = [
    "新しいスレッド",
    "投稿を作成",
    "スレッドを開始",
    "新規投稿",
    "Create a thread",
    "New thread",
    "Post",
    "Create",
    "投稿",
]

COMPOSER_ARIA_LABELS = [
    "新しいスレッド",
    "投稿を作成",
    "新規投稿",
    "Create a thread",
    "New thread",
    "Create",
]

COMPOSER_FALLBACK_SELECTORS = [
    'svg[aria-label="新しいスレッド"]',
    'svg[aria-label="新規投稿"]',
    'svg[aria-label="Create"]',
    'svg[aria-label="New thread"]',
    'div[role="button"]:has(svg[aria-label="新しいスレッド"])',
    'div[role="button"]:has(svg[aria-label="Create"])',
    'a[href*="/create"]',
    'div[contenteditable="true"]',
]

# Post composition text input field
COMPOSER_TEXTBOX_NAMES = [
    "スレッドを開始...",
    "スレッドを開始",
    "何が起きてる？",
    "Start a thread...",
    "Start a thread",
    "What's new?",
]

COMPOSER_TEXTBOX_SELECTORS = [
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"]',
    'div[role="textbox"]',
    'textarea',
]

# Post Submit buttons
POST_SUBMIT_BUTTON_NAMES = [
    "投稿",
    "Post",
    "送信",
    "Submit",
]

POST_SUBMIT_SELECTORS = [
    'div[role="button"]:has-text("投稿")',
    'div[role="button"]:has-text("Post")',
    'button:has-text("投稿")',
    'button:has-text("Post")',
]

# Logged-in indicators (present when authenticated)
LOGGED_IN_INDICATORS = [
    'svg[aria-label="プロフィール"]',
    'svg[aria-label="Profile"]',
    'svg[aria-label="ホーム"]',
    'svg[aria-label="Home"]',
    'svg[aria-label="アクティビティ"]',
    'svg[aria-label="Activity"]',
    'svg[aria-label="検索"]',
    'svg[aria-label="Search"]',
    'a[href*="/@"]',
    'a[href*="/activity"]',
]

# Logged-out / Auth required indicators
LOGGED_OUT_INDICATORS = [
    'input[name="password"]',
    'button:has-text("Instagramでログイン")',
    'button:has-text("Log in with Instagram")',
    'a[href*="/login"]',
    'text=Threadsを利用するにはログインしてください',
    'text=Log in to see what',
]

# Ghost Post native UI candidates (switches, toggles, buttons for 24h / ephemeral / ghost post)
GHOST_TOGGLE_LABELS = [
    "Ghost post",
    "Ghost",
    "ゴースト投稿",
    "ゴースト",
    "24時間で消滅",
    "24hで消滅",
    "24時間",
    "Ephemeral",
    "消滅ポスト",
]

GHOST_TOGGLE_SELECTORS = [
    'button[aria-label*="Ghost"]',
    'button[aria-label*="ゴースト"]',
    'div[role="switch"][aria-label*="Ghost"]',
    'div[role="switch"][aria-label*="ゴースト"]',
    'div[role="switch"][aria-label*="24時間"]',
    'div[role="button"][aria-label*="Ghost"]',
    'div[role="button"][aria-label*="ゴースト"]',
    'div[role="button"]:has(svg[aria-label*="Ghost"])',
    'div[role="button"]:has(svg[aria-label*="ゴースト"])',
    'button:has-text("Ghost")',
    'button:has-text("ゴースト")',
]

# Real post permalink extraction candidates from toast / success notification
POST_VIEW_LINK_SELECTORS = [
    'a[href*="/post/"]',
    'a[href*="/t/"]',
    '[role="alert"] a',
    '[role="status"] a',
    'div:has-text("投稿しました") a',
    'div:has-text("Posted") a',
]

# Success signals
SUCCESS_TOAST_SELECTORS = [
    '[role="alert"]:has-text("投稿しました")',
    '[role="alert"]:has-text("Posted")',
    '[role="status"]:has-text("投稿しました")',
    '[role="status"]:has-text("Posted")',
    'div:has-text("投稿しました")',
    'div:has-text("スレッドを投稿しました")',
    'div:has-text("Your thread was posted")',
]

# Media attachment buttons
ATTACH_MEDIA_LABELS = [
    "Attach media",
    "メディアを添付",
    "メディアの添付",
    "Add media",
    "画像を添付",
    "写真や動画を追加",
    "写真を添付",
]

ATTACH_MEDIA_SELECTORS = [
    'svg[aria-label="Attach media"]',
    'svg[aria-label="メディアを添付"]',
    'svg[aria-label="画像を添付"]',
    'div[role="button"]:has(svg[aria-label="Attach media"])',
    'div[role="button"]:has(svg[aria-label="メディアを添付"])',
    'div[role="button"]:has(svg[aria-label="画像を添付"])',
]

FILE_INPUT_SELECTORS = [
    'input[type="file"][accept*="image"]',
    'input[type="file"]',
]

# Media preview indicators (present after image upload attached to composer)
MEDIA_PREVIEW_SELECTORS = [
    'div[role="dialog"] img:not([alt*="profile"]):not([alt*="avatar"])',
    'img[alt*="Uploaded"]',
    'img[alt*="Media preview"]',
    'img[alt*="メディアプレビュー"]',
    'div[aria-label*="Media preview"]',
    'div[aria-label*="メディアプレビュー"]',
    'div[aria-label*="Attachment"]',
    'div[data-pressable-container="true"] img',
    'img[src^="blob:"]',
]

# Media upload in-progress indicators (should disappear when complete)
MEDIA_UPLOAD_PROGRESS_SELECTORS = [
    'div[role="progressbar"]',
    '[aria-label*="Loading"]',
    '[aria-label*="読み込み中"]',
    '[aria-label*="アップロード中"]',
    'svg[aria-label*="Loading"]',
]
