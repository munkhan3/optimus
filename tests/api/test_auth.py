"""Account lifecycle and tenant-boundary coverage."""

from __future__ import annotations

from fastapi.testclient import TestClient
from sqlmodel import Session

from optimus.api.models import Goal, User


def _register(client: TestClient, email: str, password: str = "correct-horse-battery") -> str:
    response = client.post("/api/auth/register", json={"email": email, "password": password})
    assert response.status_code == 201, response.text
    return response.json()["token"]


def test_account_lifecycle_and_data_isolation(client: TestClient) -> None:
    alice_token = _register(client, "alice@example.com")
    client.headers["Authorization"] = f"Bearer {alice_token}"
    goal = client.post(
        "/api/goals",
        json={
            "title": "Alice's goal",
            "kind": "goal",
            "definition_of_done": "It is complete",
            "activation": "parked",
        },
    )
    assert goal.status_code == 201
    assert goal.json()["user_id"] is not None

    bob_token = _register(client, "bob@example.com")
    client.headers["Authorization"] = f"Bearer {bob_token}"
    assert client.get("/api/goals").json() == []

    deleted = client.request("DELETE", "/api/auth/me", json={"password": "correct-horse-battery"})
    assert deleted.status_code == 204
    assert client.post(
        "/api/auth/login", json={"email": "bob@example.com", "password": "correct-horse-battery"}
    ).status_code == 401

    client.headers["Authorization"] = f"Bearer {alice_token}"
    assert [row["title"] for row in client.get("/api/goals").json()] == ["Alice's goal"]


def test_login_rejects_bad_credentials_and_duplicate_registration(client: TestClient) -> None:
    _register(client, "member@example.com", "secure-password")
    assert client.post(
        "/api/auth/register", json={"email": "MEMBER@example.com", "password": "another-password"}
    ).status_code == 409
    assert client.post(
        "/api/auth/login", json={"email": "member@example.com", "password": "wrong-password"}
    ).status_code == 401
    assert client.post(
        "/api/auth/login", json={"email": "member@example.com", "password": "secure-password"}
    ).status_code == 200


def test_first_registration_claims_the_legacy_workspace(client: TestClient, db_session: Session) -> None:
    legacy = User(email="legacy@optimus.local", password_hash="disabled")
    db_session.add(legacy)
    db_session.flush()
    db_session.add(
        Goal(
            user_id=legacy.id,
            title="Original workspace goal",
            kind="goal",
            definition_of_done="It is complete",
            dod_source="user_supplied",
            activation="parked",
        )
    )
    db_session.commit()

    token = _register(client, "owner@example.com")
    client.headers["Authorization"] = f"Bearer {token}"
    assert [row["title"] for row in client.get("/api/goals").json()] == ["Original workspace goal"]


def test_every_owned_table_is_registered_for_tenant_scoping() -> None:
    """A table with a user_id column that is not in TENANT_MODELS is a data leak.

    RLS is the intended boundary, but a superuser role bypasses it -- which is
    the normal local setup -- so scope_orm_reads is what actually holds. It
    filters only the models named in TENANT_MODELS, so forgetting to add one
    there silently exposes that table to every account. Adding `area` is exactly
    how this was found.
    """
    from sqlmodel import SQLModel

    from optimus.api.db import TENANT_MODELS

    owned = {
        cls.__name__
        for cls in SQLModel.__subclasses__()
        if getattr(cls, "__tablename__", None) and "user_id" in cls.__table__.columns
        # auth_session is scoped by token lookup, not by the request identity:
        # resolving a token is what establishes who the caller is.
        and cls.__tablename__ != "auth_session"
    }
    registered = {m.__name__ for m in TENANT_MODELS}
    assert owned - registered == set(), (
        f"tables with user_id missing from TENANT_MODELS: {sorted(owned - registered)}"
    )
