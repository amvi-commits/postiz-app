import sys
import argparse
from app.accounts import validate_account_name, get_account_profile_dir, account_exists, acquire_account_lock
from app.browser import launch_persistent_browser, check_login_state
from app.selectors import THREADS_LOGIN_URL, THREADS_BASE_URL

def run_session_check(account_name: str) -> str:
    """Run a headless session verification for the specified account."""
    valid_name = validate_account_name(account_name)
    if not account_exists(valid_name):
        print(f"AUTH_REQUIRED (Account '{valid_name}' profile does not exist)")
        return "AUTH_REQUIRED"

    with acquire_account_lock(valid_name):
        pw, context = launch_persistent_browser(valid_name, headless=True)
        try:
            page = context.pages[0] if context.pages else context.new_page()
            state = check_login_state(page, timeout_ms=10000)
            print(state)
            return state
        finally:
            try:
                context.close()
            except Exception:
                pass
            try:
                pw.stop()
            except Exception:
                pass

def run_interactive_login(account_name: str) -> None:
    """Launch a headful browser session for manual user login into Threads."""
    valid_name = validate_account_name(account_name)
    profile_dir = get_account_profile_dir(valid_name, create=True)

    print(f"=== Threads 初回ログインセットアップ: アカウント [{valid_name}] ===")
    print(f"セッション保存先: {profile_dir}")
    print("ブラウザ（Chromium）を起動しています...")

    with acquire_account_lock(valid_name):
        pw, context = launch_persistent_browser(valid_name, headless=False)
        try:
            page = context.pages[0] if context.pages else context.new_page()
            print(f"Threadsログインページを開いています: {THREADS_LOGIN_URL}")
            page.goto(THREADS_LOGIN_URL)

            print("\n" + "=" * 60)
            print("【手動操作】")
            print("ブラウザ上でThreadsアカウントへのログイン操作を行ってください。")
            print("（※ 本ツールはパスワードや2FA/OTP情報を取得・保存しません）")
            print("=" * 60)

            input("\nThreadsへのログインが完了したらEnterを押してください: ")

            print("ログイン状態を確認しています...")
            page.goto(THREADS_BASE_URL, wait_until="domcontentloaded")
            state = check_login_state(page, timeout_ms=10000)

            if state == "SESSION_OK":
                print(f"\n[OK] ログインを確認しました (状態: {state})。")
            elif state == "SESSION_UNKNOWN":
                print(f"\n[INFO] ログイン状態を完全には自動判別できませんでしたがセッションを保存しました (状態: {state})。")
            else:
                print(f"\n[WARN] ログインが未完了の可能性があります (状態: {state})。")

            print(f"[完了] ログインプロファイルを保存しました: sessions/{valid_name}\n")
        finally:
            try:
                context.close()
            except Exception:
                pass
            try:
                pw.stop()
            except Exception:
                pass

def main():
    parser = argparse.ArgumentParser(description="Threads Browser Worker Login CLI")
    parser.add_argument("account", nargs="?", default=None, help="Account identifier (e.g. main)")
    parser.add_argument("--check", action="store_true", help="Check session login status in headless mode")

    args = parser.parse_args()

    account = args.account
    if not account:
        account = input("対象のアカウント名を入力してください (例: main): ").strip()

    if not account:
        print("エラー: アカウント名が指定されていません。")
        sys.exit(1)

    try:
        if args.check:
            state = run_session_check(account)
            sys.exit(0 if state == "SESSION_OK" else 1)
        else:
            run_interactive_login(account)
    except Exception as e:
        print(f"エラーが発生しました: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
