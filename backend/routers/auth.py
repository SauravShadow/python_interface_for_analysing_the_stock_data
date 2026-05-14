"""
routers/auth.py — Authentication endpoints
"""
from fastapi import APIRouter
from schemas.auth import LoginRequest, OTPRequest, AuthStatus
from services.flattrade import flattrade_service

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/start-login")
async def start_login(req: LoginRequest):
    """
    Kick off the headless Playwright login flow in a background thread.
    The thread will pause at the OTP step until /submit-otp is called.
    """
    flattrade_service.start_login(req.password, req.pan_or_dob)
    return {"status": "started", "msg": "Login started. Poll /auth/status for progress."}


@router.post("/submit-otp")
async def submit_otp(req: OTPRequest):
    """Pass the OTP entered by the user into the waiting login thread."""
    if flattrade_service.login_state.status != "waiting_otp":
        return {"status": "error", "msg": "Not waiting for OTP right now."}
    flattrade_service.submit_otp(req.otp)
    return {"status": "otp_submitted", "msg": "OTP submitted. Completing login..."}


@router.get("/status", response_model=AuthStatus)
async def get_status():
    """Poll this to track login progress and session validity."""
    ls = flattrade_service.login_state
    return AuthStatus(
        logged_in=flattrade_service.is_logged_in(),
        client_id=ls.client_id,
        token_age_hours=flattrade_service.get_token_age_hours(),
        token_hours_remaining=flattrade_service.get_token_hours_remaining(),
        status=ls.status,
        error=ls.error,
    )


@router.post("/logout")
async def logout():
    """Clear the session token from disk and memory."""
    path = flattrade_service._session_file()
    if path.exists():
        path.unlink()
    flattrade_service._api = None
    flattrade_service._token = None
    flattrade_service._token_loaded_at = None
    flattrade_service.login_state.reset()
    return {"status": "logged_out"}
