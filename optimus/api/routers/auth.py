"""Public account endpoints plus authenticated self-service deletion."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from ..auth import (
    create_session,
    disable_legacy_bridge,
    hash_password,
    normalize_email,
    require_user,
    token_digest,
    verify_password,
)
from ..db import get_session
from ..models import AuthSession, User
from ..schemas import AccountCreate, AccountDelete, AccountLogin

router = APIRouter(prefix="/api/auth", tags=["auth"])
LEGACY_EMAIL = "legacy@optimus.local"
TENANT_TABLES = (
    "goal", "milestone", "trackable", "task", "capacity", "goal_budget",
    "weekly_commitment", "work_session", "progress_check", "baseline",
    "open_gap", "daily_plan", "plan_item",
)


def user_payload(user: User) -> dict:
    return {"id": user.id, "email": user.email, "created_at": user.created_at}


def claim_legacy_data(db: Session, user: User) -> None:
    """Move the original token-only workspace into the first new account."""
    legacy = db.exec(select(User).where(User.email == LEGACY_EMAIL)).first()
    normal_account_exists = db.exec(
        select(User.id).where(User.email != LEGACY_EMAIL).where(User.id != user.id)
    ).first()
    if legacy is None or normal_account_exists is not None:
        return
    for table in TENANT_TABLES:
        db.execute(
            text(f"UPDATE {table} SET user_id = :user_id WHERE user_id = :legacy_id"),
            {"user_id": user.id, "legacy_id": legacy.id},
        )
    db.delete(legacy)


@router.post("/register", status_code=status.HTTP_201_CREATED)
def register(body: AccountCreate, db: Session = Depends(get_session)) -> dict:
    email = normalize_email(body.email)
    if db.exec(select(User).where(User.email == email)).first() is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "An account with that email already exists.")
    user = User(email=email, password_hash=hash_password(body.password))
    db.add(user)
    try:
        db.flush()
        claim_legacy_data(db, user)
        token = create_session(db, user)
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "An account with that email already exists.") from exc
    db.refresh(user)
    disable_legacy_bridge()
    return {"token": token, "user": user_payload(user)}


@router.post("/login")
def login(body: AccountLogin, db: Session = Depends(get_session)) -> dict:
    email = normalize_email(body.email)
    user = db.exec(select(User).where(User.email == email)).first()
    if user is None or not verify_password(body.password, user.password_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Email or password is incorrect.")
    token = create_session(db, user)
    db.commit()
    return {"token": token, "user": user_payload(user)}


@router.get("/me")
def me(user: User = Depends(require_user)) -> dict:
    return user_payload(user)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(
    credentials: HTTPAuthorizationCredentials | None = Depends(HTTPBearer(auto_error=False)),
    user: User = Depends(require_user),
    db: Session = Depends(get_session),
) -> None:
    """Revoke the presented token, server side.

    Clearing the client's copy alone would leave a working token in existence:
    anything that captured it stays signed in, and "sign out" would be a claim
    the server never honoured. Only this session is dropped, so signing out on
    a laptop leaves the phone alone.
    """
    if credentials is not None:
        session_row = db.exec(
            select(AuthSession).where(AuthSession.token_hash == token_digest(credentials.credentials))
        ).first()
        if session_row is not None:
            db.delete(session_row)
    db.commit()


@router.delete("/me", status_code=status.HTTP_204_NO_CONTENT)
def delete_me(
    body: AccountDelete,
    user: User = Depends(require_user),
    db: Session = Depends(get_session),
) -> None:
    if not verify_password(body.password, user.password_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Password is incorrect.")
    # The user_id FKs on tenant tables are ON DELETE CASCADE. Removing the user
    # is intentionally irreversible: plans, history, account sessions, and
    # every dependent record are erased in one transaction.
    db.delete(user)
    db.commit()
