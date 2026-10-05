import time
import logging
from typing import Optional
from fastapi import FastAPI, Header, HTTPException, Request, Depends, status
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError

from app.config import settings
from app.errors import (
    ThreadsWorkerError,
    AccountNotFoundError,
    AuthRequiredError,
)
from app.models import (
    HealthResponse,
    AccountsResponse,
    SessionCheckRequest,
    SessionCheckResponse,
    PostRequest,
    PostResponseModel,
)
from app.accounts import list_accounts, account_exists, acquire_account_lock
from app.browser import launch_persistent_browser, check_login_state
from app.publisher import publish_thread

# Configure structured logging (no cookies, passwords, or tokens)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] [%(name)s] %(message)s",
)
logger = logging.getLogger("threads_browser_worker")

app = FastAPI(
    title="Threads Browser Publishing Worker",
    version="1.0.0",
    docs_url="/docs",
    redoc_url=None,
)

# Authentication dependency using X-Threads-Service-Key
def verify_service_key(x_threads_service_key: Optional[str] = Header(default=None)):
    """Enforce X-Threads-Service-Key header authentication when THREADS_BROWSER_SERVICE_KEY is configured."""
    if settings.SERVICE_KEY:
        if not x_threads_service_key or x_threads_service_key != settings.SERVICE_KEY:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail={
                    "status": "error",
                    "code": "AUTH_REQUIRED",
                    "message": "有効な X-Threads-Service-Key が指定されていません。",
                },
            )
    return True

# Exception Handlers
@app.exception_handler(ThreadsWorkerError)
async def handle_threads_worker_error(request: Request, exc: ThreadsWorkerError):
    return JSONResponse(
        status_code=exc.status_code,
        content=exc.to_dict(),
    )

@app.exception_handler(RequestValidationError)
async def handle_validation_error(request: Request, exc: RequestValidationError):
    error_msg = "; ".join([f"{'.'.join(str(loc) for loc in err['loc'])}: {err['msg']}" for err in exc.errors()])
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content={
            "status": "error",
            "code": "VALIDATION_ERROR",
            "message": error_msg,
        },
    )

@app.exception_handler(Exception)
async def handle_generic_exception(request: Request, exc: Exception):
    logger.error(f"Unhandled server error: {exc}", exc_info=False)
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={
            "status": "error",
            "code": "INTERNAL_ERROR",
            "message": "内部サーバーエラーが発生しました。",
        },
    )

# Endpoints
@app.get("/health", response_model=HealthResponse)
async def health():
    """Liveness probe. Does not communicate with Threads and requires no auth."""
    return HealthResponse(status="ok", playwright=True)

@app.get(
    "/api/threads/accounts",
    response_model=AccountsResponse,
    dependencies=[Depends(verify_service_key)],
)
async def get_accounts():
    """List valid registered Threads accounts with existing persistent profiles."""
    accounts = list_accounts()
    return AccountsResponse(accounts=accounts)

@app.post(
    "/api/threads/session/check",
    response_model=SessionCheckResponse,
    dependencies=[Depends(verify_service_key)],
)
async def check_session(req: SessionCheckRequest):
    """Check whether the persistent profile for the given account is authenticated with Threads."""
    if not account_exists(req.account):
        raise AccountNotFoundError(req.account)

    with acquire_account_lock(req.account):
        pw, context = launch_persistent_browser(req.account, headless=True)
        try:
            page = context.pages[0] if context.pages else context.new_page()
            state = check_login_state(page, timeout_ms=10000)
            return SessionCheckResponse(account=req.account, status=state)
        finally:
            try:
                context.close()
            except Exception:
                pass
            try:
                pw.stop()
            except Exception:
                pass

@app.post(
    "/api/threads/post",
    response_model=PostResponseModel,
    dependencies=[Depends(verify_service_key)],
)
async def create_post(req: PostRequest):
    """Publish a post to Threads using the account's persistent browser profile."""
    start_time = time.time()
    logger.info(f"POST /api/threads/post: account={req.account}, dry_run={req.dry_run}, req_id={req.request_id}")

    res = publish_thread(
        account=req.account,
        text=req.text,
        is_ghost=req.is_ghost,
        dry_run=req.dry_run,
        request_id=req.request_id,
    )

    elapsed = round(time.time() - start_time, 2)
    logger.info(f"Finished /api/threads/post: account={req.account}, status={res.status}, elapsed={elapsed}s")
    return res

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "app.main:app",
        host=settings.HOST,
        port=settings.PORT,
        reload=False,
    )
