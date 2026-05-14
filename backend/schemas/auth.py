from pydantic import BaseModel
from typing import Optional


class LoginRequest(BaseModel):
    password: str
    pan_or_dob: str


class OTPRequest(BaseModel):
    otp: str


class AuthStatus(BaseModel):
    logged_in: bool
    client_id: Optional[str] = None
    token_age_hours: Optional[float] = None
    token_hours_remaining: Optional[float] = None
    status: str  # "idle" | "running" | "waiting_otp" | "done" | "error"
    error: Optional[str] = None
