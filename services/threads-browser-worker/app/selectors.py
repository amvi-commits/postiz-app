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
    "最近どう？",
    "最近どう?",
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
    "最近どう？",
    "最近どう?",
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
    'div[role="button"]:has-text("新しいスレッド")',
    'div[role="button"]:has-text("最近どう？")',
    '[role="link"]:has-text("新しいスレッド")',
    'div:has-text("最近どう？")',
    'a[href*="/create"]',
    'div[contenteditable="true"]',
]

# Post composition text input field
COMPOSER_TEXTBOX_NAMES = [
    "最近どう？",
    "最近どう?",
    "スレッドを開始...",
    "スレッドを開始",
    "何が起きてる？",
    "Start a thread...",
    "Start a thread",
    "What's new?",
    "What's new",
]

COMPOSER_TEXTBOX_SELECTORS = [
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"]:has-text("最近どう？")',
    '[contenteditable="true"][aria-label*="最近どう？"]',
    '[contenteditable="true"][placeholder*="最近どう？"]',
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

# Priority 1: Guest / Login modal dialogs (top priority - blocks UI interaction)
LOGGED_OUT_MODAL_SELECTORS = [
    '[role="dialog"]:has-text("ログイン")',
    '[role="dialog"]:has-text("Log in")',
    '[role="dialog"]:has-text("Threadsでもっと発信しよう")',
    '[role="dialog"]:has-text("Instagramでログイン")',
    '[role="dialog"]:has-text("Log in with Instagram")',
    '[role="dialog"]:has-text("サインアップ")',
    '[role="dialog"]:has-text("Sign up")',
    'div[aria-modal="true"]:has-text("ログイン")',
    'div[aria-modal="true"]:has-text("Log in")',
    'div[aria-modal="true"]:has-text("Threadsでもっと発信しよう")',
]

# Priority 4: Explicit unauthenticated prompts / CTAs anywhere on page
LOGGED_OUT_INDICATORS = [
    ':has-text("Threadsでもっと発信しよう")',
    ':has-text("Instagramでログイン")',
    ':has-text("Log in with Instagram")',
    ':has-text("Threadsにログインするかサインアップ")',
    ':has-text("Log in or sign up for Threads")',
    ':has-text("代わりにユーザーネームでログイン")',
    ':has-text("Log in with username instead")',
    ':has-text("Log in to Threads")',
    ':has-text("Threadsを利用するにはログインしてください")',
    ':has-text("Log in to see what")',
    'a[href*="/login"]',
    'svg[aria-label="ログイン"]',
    'svg[aria-label="Log in"]',
    'input[name="password"]',
    'input[type="password"]',
    'input[name="username"]',
]

# Priority 5: Strong authenticated-only indicators (MUST NOT match guest/logged-out states)
# NEVER include generic navigation icons (Home, Search, Activity, Profile icon) which exist on public guest feeds.
AUTHENTICATED_INDICATORS = [
    # 1. Inline feed composer & prompt (central top of feed when logged in)
    'div:has-text("最近どう？"):has([role="button"]:has-text("投稿"))',
    'div:has-text("What\'s new"):has([role="button"]:has-text("Post"))',
    'div[contenteditable="true"]:has-text("最近どう？")',
    'div[role="textbox"]:has-text("最近どう？")',
    '[contenteditable="true"][aria-label*="最近どう？"]',
    '[role="textbox"][aria-label*="最近どう？"]',
    '[placeholder*="最近どう？"]',
    '[contenteditable="true"][placeholder*="What\'s new"]',
    # 2. Active composer triggers in sidebar / feed
    'div[role="button"]:has(svg[aria-label="新しいスレッド"])',
    'div[role="button"]:has(svg[aria-label="新規投稿"])',
    'div[role="button"]:has(svg[aria-label="Create"])',
    'div[role="button"]:has(svg[aria-label="New thread"])',
    'div[role="button"]:has(svg[aria-label="スレッドを開始"])',
    'nav [role="button"]:has-text("新しいスレッド")',
    '[role="navigation"] [role="button"]:has-text("新しいスレッド")',
    '[role="link"]:has-text("新しいスレッド")',
    'svg[aria-label="新しいスレッド"]',
    'svg[aria-label="新規投稿"]',
    'svg[aria-label="Create a thread"]',
    'svg[aria-label="New thread"]',
    # 3. Sidebar: Saved posts ("保存済み" / /saved)
    'a[href*="/saved"]',
    '[role="button"]:has-text("保存済み")',
    '[role="link"]:has-text("保存済み")',
    'svg[aria-label="保存済み"]',
    'svg[aria-label="Saved"]',
    # 4. Sidebar: Liked posts ("いいね！済み" / "「いいね！」済み" / /liked)
    'a[href*="/liked"]',
    '[role="button"]:has-text("いいね！済み")',
    '[role="button"]:has-text("「いいね！」済み")',
    '[role="link"]:has-text("いいね！済み")',
    '[role="link"]:has-text("「いいね！」済み")',
    'svg[aria-label*="いいね！済み"]',
    'svg[aria-label*="Liked"]',
    # 5. Sidebar: Ghost posts ("ゴースト投稿" / /ghost)
    'a[href*="/ghost"]',
    '[role="button"]:has-text("ゴースト投稿")',
    '[role="link"]:has-text("ゴースト投稿")',
    'svg[aria-label*="ゴースト"]',
    # 6. Sidebar: Archive ("アーカイブ" / /archive)
    'a[href*="/archive"]',
    '[role="button"]:has-text("アーカイブ")',
    '[role="link"]:has-text("アーカイブ")',
    'svg[aria-label="アーカイブ"]',
    'svg[aria-label="Archive"]',
    # 7. Sidebar: Insights ("インサイト" / /insights)
    'a[href*="/insights"]',
    'nav [role="button"]:has-text("インサイト")',
    '[role="navigation"] [role="button"]:has-text("インサイト")',
    '[role="link"]:has-text("インサイト")',
    'svg[aria-label="インサイト"]',
    'svg[aria-label="Insights"]',
    # 8. Sidebar: Messages ("メッセージ" / /messages)
    'a[href^="/messages"]',
    'a[href*="/messages"]',
    'nav [role="button"]:has-text("メッセージ")',
    '[role="navigation"] [role="button"]:has-text("メッセージ")',
    '[role="link"]:has-text("メッセージ")',
    'svg[aria-label="Direct messages"]',
    # 9. Feed tabs: "フォロー中" / "おすすめ"
    '[role="tab"]:has-text("フォロー中")',
    '[role="tab"]:has-text("Following")',
    'a[href*="/following"]',
    # 10. User settings / session menu
    ':has-text("アカウントを切り替え")',
    ':has-text("Switch accounts")',
    ':has-text("ログアウト")',
    ':has-text("Log out")',
    'svg[aria-label="ピン留め"]',
    'svg[aria-label="Pin"]',
    'svg[aria-label="下書き"]',
    'svg[aria-label="Drafts"]',
]

# Alias for backwards compatibility
LOGGED_IN_INDICATORS = AUTHENTICATED_INDICATORS

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
