"""Password-backed account sessions and request identity."""

from __future__ import annotations

import base64
import hashlib
import secrets
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlmodel import Session, select

from .db import get_session
from .models import AuthSession, User
from .settings import Settings, get_settings

_scheme = HTTPBearer(auto_error=False)
SESSION_DAYS = 30
_legacy_user_id: int | None = None
_legacy_bridge_disabled = False


def _utcnow() -> datetime:
    return datetime.now(UTC)


def normalize_email(email: str) -> str:
    value = email.strip().lower()
    if len(value) > 320 or "@" not in value or value.startswith("@") or value.endswith("@"):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Enter a valid email address.")
    return value


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2**14, r=8, p=1)
    return "scrypt$" + base64.urlsafe_b64encode(salt).decode() + "$" + base64.urlsafe_b64encode(digest).decode()


def verify_password(password: str, encoded: str) -> bool:
    try:
        algorithm, salt_text, digest_text = encoded.split("$", 2)
        if algorithm != "scrypt":
            return False
        salt = base64.urlsafe_b64decode(salt_text.encode())
        expected = base64.urlsafe_b64decode(digest_text.encode())
        actual = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2**14, r=8, p=1)
        return secrets.compare_digest(actual, expected)
    except (ValueError, TypeError):
        return False


def token_digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def create_session(db: Session, user: User) -> str:
    token = secrets.token_urlsafe(32)
    db.add(
        AuthSession(
            user_id=user.id,
            token_hash=token_digest(token),
            expires_at=_utcnow() + timedelta(days=SESSION_DAYS),
        )
    )
    return token


def disable_legacy_bridge() -> None:
    """Once a normal account exists, the old deployment token stops working."""
    global _legacy_bridge_disabled
    _legacy_bridge_disabled = True


def reset_legacy_bridge() -> None:
    """Clear process-local bridge state after a database reset."""
    global _legacy_bridge_disabled, _legacy_user_id
    _legacy_bridge_disabled = False
    _legacy_user_id = None


def require_user(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_scheme),
    db: Session = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> User:
    """Resolve an opaque access token and scope all following DB reads/writes."""
    if credentials is None:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "Sign in to continue.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    if not _legacy_bridge_disabled and settings.auth_token and secrets.compare_digest(
        credentials.credentials, settings.auth_token
    ):
        # A one-time bridge for the original single-token deployment. It keeps
        # existing local installs operable long enough to create a real account;
        # it is deliberately unavailable once any account has been registered.
        global _legacy_user_id
        if _legacy_user_id is not None:
            request.state.user_id = _legacy_user_id
            return User(id=_legacy_user_id, email="legacy@optimus.local", password_hash="disabled")
        user = db.exec(select(User).limit(1)).first()
        if user is None:
            user = User(email="legacy@optimus.local", password_hash="disabled")
            db.add(user)
            db.commit()
            db.refresh(user)
        if user.email == "legacy@optimus.local":
            _legacy_user_id = user.id
            request.state.user_id = user.id
            return user

    auth_session = db.exec(
        select(AuthSession).where(AuthSession.token_hash == token_digest(credentials.credentials))
    ).first()

    if auth_session is None or auth_session.expires_at <= _utcnow():
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "Your session has expired. Sign in again.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    user = db.get(User, auth_session.user_id)
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Account not found.")
    request.state.user_id = user.id
    return user


def get_user_session(
    request: Request, _: User = Depends(require_user)
) -> Iterator[Session]:
    """Open a DB session only after the request identity has been established."""
    yield from get_session(request)
