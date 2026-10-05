"""Standardized error contracts and custom exceptions for Threads Browser Worker."""

class ThreadsWorkerError(Exception):
    """Base exception for all Threads Browser Worker errors."""
    def __init__(self, code: str, message: str, status_code: int = 400):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code

    def to_dict(self, request_id: str | None = None) -> dict:
        result = {
            "status": "error",
            "code": self.code,
            "message": self.message,
        }
        if request_id:
            result["request_id"] = request_id
        return result


class AccountNotFoundError(ThreadsWorkerError):
    def __init__(self, account: str):
        super().__init__(
            code="ACCOUNT_NOT_FOUND",
            message=f"アカウント '{account}' のプロファイルが見つかりません。初回ログインを行ってください。",
            status_code=404,
        )


class AccountBusyError(ThreadsWorkerError):
    def __init__(self, account: str):
        super().__init__(
            code="ACCOUNT_BUSY",
            message=f"アカウント '{account}' は現在別プロセスで使用中です。",
            status_code=409,
        )


class AuthRequiredError(ThreadsWorkerError):
    def __init__(self, message: str = "Threadsへの再ログインが必要です。"):
        super().__init__(
            code="AUTH_REQUIRED",
            message=message,
            status_code=401,
        )


class InvalidAccountNameError(ThreadsWorkerError):
    def __init__(self, account: str):
        super().__init__(
            code="INVALID_ACCOUNT_NAME",
            message=f"アカウント名 '{account}' は無効です。半角英数字、アンダースコア、ハイフン（1-64文字）のみ使用可能です。",
            status_code=400,
        )


class ComposerNotFoundError(ThreadsWorkerError):
    def __init__(self, message: str = "Threads投稿コンポーザーが見つかりませんでした。"):
        super().__init__(
            code="COMPOSER_NOT_FOUND",
            message=message,
            status_code=502,
        )


class PostButtonNotFoundError(ThreadsWorkerError):
    def __init__(self, message: str = "Threads投稿ボタンが見つかりませんでした。"):
        super().__init__(
            code="POST_BUTTON_NOT_FOUND",
            message=message,
            status_code=502,
        )


class GhostNotAvailableError(ThreadsWorkerError):
    def __init__(self, message: str = "Threads Web UI上でGhost Post操作が利用できません。"):
        super().__init__(
            code="GHOST_NOT_AVAILABLE",
            message=message,
            status_code=409,
        )


class PostSubmitFailedError(ThreadsWorkerError):
    def __init__(self, message: str = "Threads投稿の送信処理に失敗しました。"):
        super().__init__(
            code="POST_SUBMIT_FAILED",
            message=message,
            status_code=500,
        )


class PostStatusUnknownError(ThreadsWorkerError):
    def __init__(self, message: str = "Threads投稿の成功状態を確認できませんでした。"):
        super().__init__(
            code="POST_STATUS_UNKNOWN",
            message=message,
            status_code=500,
        )


class TimeoutError(ThreadsWorkerError):
    def __init__(self, message: str = "Threadsブラウザ処理がタイムアウトしました。"):
        super().__init__(
            code="TIMEOUT",
            message=message,
            status_code=504,
        )


class InternalError(ThreadsWorkerError):
    def __init__(self, message: str = "内部エラーが発生しました。"):
        super().__init__(
            code="INTERNAL_ERROR",
            message=message,
            status_code=500,
        )


class MediaUploadFailedError(ThreadsWorkerError):
    def __init__(self, message: str = "メディアのアップロード・添付に失敗しました。"):
        super().__init__(
            code="MEDIA_UPLOAD_FAILED",
            message=message,
            status_code=500,
        )


class InvalidMediaError(ThreadsWorkerError):
    def __init__(self, message: str = "メディアファイルの形式または指定が無効です。"):
        super().__init__(
            code="INVALID_MEDIA",
            message=message,
            status_code=400,
        )


class MediaTooLargeError(ThreadsWorkerError):
    def __init__(self, message: str = "メディアサイズが上限を超えています。"):
        super().__init__(
            code="MEDIA_TOO_LARGE",
            message=message,
            status_code=400,
        )


class GhostStateUnknownError(ThreadsWorkerError):
    def __init__(self, message: str = "Ghost Post状態の有効化を確認できませんでした。"):
        super().__init__(
            code="GHOST_STATE_UNKNOWN",
            message=message,
            status_code=409,
        )


class ServiceKeyNotConfiguredError(ThreadsWorkerError):
    def __init__(self, message: str = "THREADS_BROWSER_SERVICE_KEY が設定されていません。"):
        super().__init__(
            code="SERVICE_KEY_NOT_CONFIGURED",
            message=message,
            status_code=500,
        )
