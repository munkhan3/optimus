"""The read-only assistant surface (§26).

The tool handlers are plain database reads, so everything except the model call
itself is testable without credentials -- which is most of what matters: whether
the assistant can write, and whether it sees the same numbers the UI does.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

from optimus.api.llm.tools import TOOL_DECLARATIONS, dispatch
from tests.db_fixtures import log_session


@pytest.fixture
def populated(client: TestClient, seeded: dict) -> dict:
    for output in (9, 8, 11, 9, 10, 7):
        log_session(client, seeded["trackable"]["id"], output)
    client.post("/api/capacity", json={"week_start": "2026-08-24", "available_hours": 10})
    client.put("/api/capacity/1/budgets", json={"goal_id": 1, "budgeted_sessions": 6})
    return seeded


# ------------------------------------------------------------------ the boundary


def test_v0_exposes_no_write_tools(client: TestClient):
    """D10/P1: the model never owns state. §34 gates writes on demonstrated trust."""
    body = client.get("/api/assistant/tools").json()
    assert body["write_tools"] == []
    assert len(body["tools"]) == 9

    forbidden = ("create", "update", "delete", "set_", "log_", "commit", "rebaseline")
    for tool in body["tools"]:
        assert not any(word in tool["name"] for word in forbidden), (
            f"{tool['name']} looks like a write tool"
        )


def test_the_nine_documented_tools_are_all_present(client: TestClient):
    """§26's table, exactly."""
    names = {t.name for t in TOOL_DECLARATIONS}
    assert names == {
        "get_goal_state", "get_pace", "get_feasibility", "get_plan",
        "get_sessions", "get_budget_status", "get_baselines",
        "get_progress_history", "get_open_gaps",
    }


def test_unknown_tools_are_refused_not_guessed_at(db_session: Session):
    result = dispatch(db_session, "delete_everything", {})
    assert "error" in result


def test_a_failing_tool_returns_an_error_rather_than_raising(db_session: Session):
    """Errors go back to the model as data so it can recover or say it failed."""
    result = dispatch(db_session, "get_pace", {"trackable_id": 99999})
    assert "error" in result


# ------------------------------------------------------------------- the numbers


def test_get_pace_matches_what_the_ui_shows(client: TestClient, populated, db_session):
    """The assistant must not be able to drift from the screen.

    Both paths go through the same engine, so if this ever diverges it means
    somebody recomputed a metric locally instead of calling it.
    """
    tid = populated["trackable"]["id"]
    ui = client.get(f"/api/trackables/{tid}").json()
    tool = dispatch(db_session, "get_pace", {"trackable_id": tid})

    assert tool["pace"]["point"] == ui["pace"]["point"]
    assert tool["pace"]["basis"] == ui["pace"]["basis"]
    assert tool["drift"] == ui["drift"]
    assert tool["projection"] == ui["projection"]


def test_get_goal_state_carries_provenance_and_basis(client, populated, db_session):
    """D3/P2: the assistant must be able to tell measured from estimated."""
    state = dispatch(db_session, "get_goal_state", {"goal_id": None})
    assert state
    goal = state[0]
    assert goal["dod_source"] in ("user_supplied", "model_estimated")
    trackable = goal["milestones"][0]["trackables"][0]
    assert trackable["total_units_source"] in ("grounded", "user_supplied", "model_estimated")
    assert trackable["pace"]["basis"] in ("observed", "shrunk", "prior_only", "unavailable")


def test_get_feasibility_reports_undetermined_as_null_not_true(client, seeded, db_session):
    """No capacity declared -> the fit is unknown, which is not the same as fine."""
    result = dispatch(db_session, "get_feasibility", {"goal_id": seeded["goal"]["id"]})
    assert result["items"]
    assert result["items"][0]["feasibility"]["feasible"] is None


def test_get_baselines_always_surfaces_version_one(client, seeded, db_session):
    """§25.3: v1 is named explicitly so a summary cannot quietly drop it."""
    tid = seeded["trackable"]["id"]
    client.post(f"/api/baselines/rebaseline?trackable_id={tid}", json={
        "resolution": "cut_scope", "rationale": "the last 80 pages are reference",
        "planned_sessions": 16, "target_date": "2026-12-01",
    })
    result = dispatch(db_session, "get_baselines", {"trackable_id": tid})
    assert result["original"]["version"] == 1
    assert result["original"]["planned_sessions"] == 20
    assert result["current"]["version"] == 2
    assert result["current"]["rationale"]


def test_progress_history_is_labelled_as_a_review_signal(client, seeded, db_session):
    """D12: the tool output states the constraint, so the model cannot misuse it."""
    result = dispatch(db_session, "get_progress_history",
                      {"milestone_id": seeded["milestone"]["id"]})
    assert "not an input" in result["note"]
    assert "stalled" in result


def test_open_gaps_come_back_highest_priority_first(client, seeded, db_session):
    """§22.2: ask where being wrong is expensive, in that order."""
    mid = seeded["milestone"]["id"]
    for title in ("Paper A", "Paper B"):
        client.post("/api/trackables", json={
            "milestone_id": mid, "title": title, "unit": "pages", "total_units": 100,
            "total_units_source": "model_estimated", "task_type": "reading",
        })
    gaps = dispatch(db_session, "get_open_gaps", {})
    assert len(gaps) == 2
    assert gaps == sorted(gaps, key=lambda g: -g["priority"])
    assert all(g["trackable_id"] is not None for g in gaps)


def test_get_sessions_exposes_the_flags_that_change_weighting(client, populated, db_session):
    """The assistant needs to see interrupted/retroactive to explain a number."""
    client.post("/api/sessions", json={
        "trackable_id": populated["trackable"]["id"],
        "started_at": "2026-08-26T09:00:00Z", "actual_output": 15,
    })
    rows = dispatch(db_session, "get_sessions",
                    {"since": None, "trackable_id": None, "limit": None})
    assert rows
    assert any(r["entered_retroactively"] for r in rows)
    assert all("interrupted" in r for r in rows)


# ------------------------------------------------------------------ no credentials


def test_the_assistant_fails_closed_without_a_key(client: TestClient, monkeypatch):
    """P2 again: better offline than quietly worse."""
    from optimus.api import settings
    from optimus.api.llm import client as llm_client

    llm_client.get_client.cache_clear()
    settings.get_settings.cache_clear()
    monkeypatch.setenv("OPTIMUS_GEMINI_API_KEY", "")

    r = client.post("/api/assistant", json={"question": "how am I doing?"})
    assert r.status_code == 503

    settings.get_settings.cache_clear()
    llm_client.get_client.cache_clear()
