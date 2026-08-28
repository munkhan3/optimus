"""Single-user bearer-token auth (§19).

v0 has exactly one user, so there is no user table and no session management.
There is still a real trust boundary: the app is deployed publicly, so this
token is the only thing protecting the data.

Two deliberate choices:
  - An unset token rejects everything. A missing secret must fail closed; the
    alternative is a public database.
  - Comparison is constant-time, so the token cannot be recovered by timing.
"""

from __future__ import annotations

import secrets

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .settings import Settings, get_settings

_scheme = HTTPBearer(auto_error=False)


def require_token(
    credentials: HTTPAuthorizationCredentials | None = Depends(_scheme),
    settings: Settings = Depends(get_settings),
) -> None:
    if not settings.auth_token:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="OPTIMUS_AUTH_TOKEN is not configured; refusing all requests.",
        )
    if credentials is None or not secrets.compare_digest(
        credentials.credentials, settings.auth_token
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing bearer token.",
            headers={"WWW-Authenticate": "Bearer"},
        )
