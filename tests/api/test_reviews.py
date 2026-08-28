"""The weekly review (§15.4).

Reviews are where inferred values get corrected and scope gets renegotiated, so
what matters is that nothing the system guessed can quietly stay guessed, and
that rebaseline prompts respect the §25.4 gate.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from tests.db_fixtures import log_session


@pytest.fixture
def week(client: TestClient, seeded: dict) -> dict:
    client.post("/api/capacity", json={"week_start": "2026-08-24", "available_hours": 10})
    client.put("/api/capacity/1/budgets", json={"goal_id": 1, "budgeted_sessions": 6})
    client.post("/api/planning/commit", json=[
        {"trackable_id": seeded["trackable"]["id"], "committed_sessions": 6, "target_units": 100},
    ])
    return seeded


def test_plan_vs_actual_reports_both_sides(client: TestClient, week: dict):
    tid = week["trackable"]["id"]
    for _ in range(2):
        log_session(client, tid, 20)

    review = client.get("/api/reviews/weekly?week=2026-08-24").json()
    row = review["plan_vs_actual"][0]
    assert row["committed_sessions"] == 6
    assert row["sessions_used"] == 2
    assert row["target_units"] == 100
    assert row["units_done"] == 40
    assert row["hit_target"] is False


def test_calibration_is_reported_per_task_type(client: TestClient, week: dict):
    """§8: completion ratios trending toward 1.0 is a success criterion."""
    tid = week["trackable"]["id"]
    for _ in range(4):
        log_session(client, tid, 10)

    review = client.get("/api/reviews/weekly?week=2026-08-24").json()
    assert "reading" in review["calibration"]
    assert review["calibration"]["reading"]["n"] == 4


def test_every_model_estimated_value_resurfaces(client: TestClient, week: dict):
    """D3: anything inferred is tagged and comes back at review for correction."""
    client.post("/api/trackables", json={
        "milestone_id": week["milestone"]["id"], "title": "Some paper", "unit": "pages",
        "total_units": 120, "total_units_source": "model_estimated", "task_type": "reading",
    })

    review = client.get("/api/reviews/weekly?week=2026-08-24").json()
    assert any(v["field"] == "total_units" for v in review["model_estimated_values"])
    # ...and it also left an open question behind it (AC18).
    assert review["open_gaps"]


def test_a_wide_interval_produces_no_rebaseline_prompt(client: TestClient, week: dict):
    """§25.4 / AC9: a bad week at n=2 is noise, and prompting on it teaches the
    user that the prompts are worthless."""
    tid = week["trackable"]["id"]
    for _ in range(2):
        log_session(client, tid, 2)  # badly behind the 20/session prior

    review = client.get("/api/reviews/weekly?week=2026-08-24").json()
    assert review["rebaseline_prompts"] == []


def test_sustained_underperformance_does_prompt(client: TestClient, week: dict):
    """Past the gate, real slippage surfaces with its four options."""
    tid = week["trackable"]["id"]
    for _ in range(8):
        log_session(client, tid, 2)

    review = client.get("/api/reviews/weekly?week=2026-08-24").json()
    assert review["rebaseline_prompts"]
    prompt = review["rebaseline_prompts"][0]
    assert prompt["trigger"] == "drift"
    assert prompt["options"][0] != "move_deadline"
    assert len(prompt["options"]) == 4


def test_revealed_preference_is_summarised(client: TestClient, week: dict):
    """§32: which recommendations get quietly ignored is the real signal."""
    client.post("/api/planning/day?plan_date=2026-08-28")
    items = client.get("/api/planning/day/2026-08-28").json()["items"]
    client.patch(f"/api/planning/plan-items/{items[0]['id']}", json={"user_action": "deferred"})

    review = client.get("/api/reviews/weekly?week=2026-08-24").json()
    assert review["revealed_preference"]["deferred"] == 1


def test_review_survives_an_empty_week(client: TestClient, seeded: dict):
    """§36.3: nothing logged is the most likely real scenario, not an error."""
    review = client.get("/api/reviews/weekly?week=2026-08-24").json()
    assert review["plan_vs_actual"] == []
    assert review["rebaseline_prompts"] == []
