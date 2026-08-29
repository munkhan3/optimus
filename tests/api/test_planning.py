"""Weekly commitment and daily redistribution (§25, D9)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from tests.db_fixtures import log_session


@pytest.fixture
def portfolio(client: TestClient) -> dict:
    """Two competing goals: one metered, one with no natural counter."""
    client.post("/api/goals", json={
        "title": "Q1 quant offer", "kind": "goal",
        "definition_of_done": "Signed offer", "activation": "active",
        "deadline": "2027-02-01", "stakes": 5,
    })
    client.post("/api/goals", json={
        "title": "Thesis", "kind": "goal",
        "definition_of_done": "Accepted by advisor", "activation": "active",
        "deadline": "2026-09-15", "stakes": 4,
    })
    client.post("/api/milestones", json={
        "goal_id": 1, "title": "Finish the Green Book",
        "definition_of_done": "All 380 pages read",
    })
    client.post("/api/trackables", json={
        "milestone_id": 1, "title": "Green Book", "unit": "pages",
        "total_units": 380, "total_units_source": "grounded",
        "task_type": "reading", "prior_pace": 20, "target_date": "2026-12-01",
    })
    # §10: no natural counter, so budgeted in sessions rather than fake units.
    client.post("/api/milestones", json={
        "goal_id": 2, "title": "Secure two referrals",
        "definition_of_done": "Two people have agreed in writing",
        "planned_sessions": 6, "deadline": "2026-09-05",
    })
    client.post("/api/capacity", json={"week_start": "2026-08-24", "available_hours": 10})
    client.put("/api/capacity/1/budgets", json={"goal_id": 1, "budgeted_sessions": 14})
    client.put("/api/capacity/1/budgets", json={"goal_id": 2, "budgeted_sessions": 8})
    return {"trackable_id": 1, "milestone_id": 2}


# ------------------------------------------------------------------- capacity


def test_budget_shows_what_it_costs_the_rest_of_the_portfolio(client, portfolio):
    """§11: there is no free reallocation and the system never presents one."""
    body = client.get("/api/capacity/current").json()
    assert body["sessions_available"] == 24         # 10h at 25min
    assert body["sessions_allocated"] == 22
    assert body["sessions_unallocated"] == 2
    assert body["over_committed"] is False
    assert [b["goal_title"] for b in body["budgets"]] == ["Q1 quant offer", "Thesis"]


def test_over_commitment_is_surfaced_not_silently_accepted(client, portfolio):
    body = client.put("/api/capacity/1/budgets",
                      json={"goal_id": 1, "budgeted_sessions": 40}).json()
    assert body["over_committed"] is True
    assert body["sessions_unallocated"] < 0


def test_a_parked_goal_cannot_be_budgeted_time(client, portfolio):
    """§12: parked goals compete for nothing."""
    client.post("/api/goals", json={
        "title": "Learn Rust", "kind": "goal",
        "definition_of_done": "Ship one CLI tool", "activation": "parked", "stakes": 2,
    })
    r = client.put("/api/capacity/1/budgets", json={"goal_id": 3, "budgeted_sessions": 4})
    assert r.status_code == 422
    assert "parked" in r.json()["detail"].lower()


# -------------------------------------------------------------------- ranking


def test_ranking_explains_itself_from_the_breakdown(client, portfolio):
    """§25.6/P3: the primary reason is generated from stored components."""
    rows = client.get("/api/planning/ranking").json()
    assert rows
    for row in rows:
        assert row["score_breakdown"]["components"]
        assert row["explanation"]
        total = sum(c["contribution"] for c in row["score_breakdown"]["components"])
        assert abs(total - row["score"]) < 1e-9


def test_counterless_milestone_outranks_an_on_pace_trackable(client, portfolio):
    """AC6 against real data -- and it wins despite LOWER stakes (4 vs 5).

    That is the point of §25.1: feasibility pressure and urgency dominate, so
    work with no natural counter is not structurally disadvantaged.
    """
    rows = client.get("/api/planning/ranking").json()
    assert rows[0]["milestone_id"] == 2
    assert rows[0]["score"] > rows[1]["score"]


def test_planning_requires_declared_capacity(client):
    """Capacity is declared, not inferred (§11)."""
    r = client.post("/api/planning/day")
    assert r.status_code == 409
    assert "capacity" in r.json()["detail"].lower()


# ------------------------------------------------------- weekly commitment


def test_committing_freezes_the_score(client, portfolio):
    rows = client.post("/api/planning/commit", json=[
        {"trackable_id": 1, "committed_sessions": 10, "target_units": 100},
        {"milestone_id": 2, "committed_sessions": 6},
    ]).json()
    assert all(r["score"] is not None for r in rows)
    assert all(r["score_breakdown"]["components"] for r in rows)


def test_ac10_logging_a_session_does_not_reshuffle_the_plan(client, portfolio):
    """AC10 / D9: two consecutive unchanged days overlap in their top items.

    The sharp form of this: logging a session visibly moves the LIVE ranking,
    and must leave the committed plan untouched. Re-scoring daily is what makes
    a plan feel arbitrary (§16).
    """
    client.post("/api/planning/commit", json=[
        {"trackable_id": 1, "committed_sessions": 10, "target_units": 100},
        {"milestone_id": 2, "committed_sessions": 6},
    ])
    client.post("/api/planning/day?plan_date=2026-08-28")
    day_one = client.get("/api/planning/day/2026-08-28").json()["items"]
    live_before = {r["label"]: r["score"] for r in client.get("/api/planning/ranking").json()}

    log_session(client, 1, 30)

    live_after = {r["label"]: r["score"] for r in client.get("/api/planning/ranking").json()}
    assert live_after["Green Book"] != live_before["Green Book"], (
        "precondition: the live score must actually move, or this test proves nothing"
    )

    client.post("/api/planning/day?plan_date=2026-08-29")
    day_two = client.get("/api/planning/day/2026-08-29").json()["items"]

    assert [i["label"] for i in day_one] == [i["label"] for i in day_two]
    assert [i["score"] for i in day_one] == [i["score"] for i in day_two]

    top_one = {i["label"] for i in day_one[:3]}
    top_two = {i["label"] for i in day_two[:3]}
    assert len(top_one & top_two) >= 2


def test_ac11_daily_allocation_never_exceeds_the_catch_up_cap(client, portfolio):
    """AC11: shortfall spreads; it never dumps on tomorrow."""
    client.post("/api/planning/commit", json=[
        {"trackable_id": 1, "committed_sessions": 10, "target_units": 100},
    ])
    for plan_date in ("2026-08-24", "2026-08-26", "2026-08-28", "2026-08-30"):
        client.post(f"/api/planning/day?plan_date={plan_date}")
        items = client.get(f"/api/planning/day/{plan_date}").json()["items"]
        for item in items:
            alloc = item["score_breakdown"]["daily_allocation"]
            assert alloc["per_day"] <= alloc["cap_value"] + 1e-9


def test_a_binding_cap_surfaces_a_rebaseline_rather_than_a_heroic_day(client, portfolio):
    """D9: if the cap binds, the week does not fit. Say so."""
    client.post("/api/planning/commit", json=[
        {"trackable_id": 1, "committed_sessions": 10, "target_units": 1000},
    ])
    body = client.post("/api/planning/day?plan_date=2026-08-30").json()
    assert body["catch_up_cap_binding"] is True
    assert body["rebaseline_suggested"] is True


def test_every_plan_item_carries_a_populated_breakdown(client, portfolio):
    """AC13 through the planning path specifically."""
    client.post("/api/planning/commit", json=[
        {"trackable_id": 1, "committed_sessions": 10, "target_units": 100},
        {"milestone_id": 2, "committed_sessions": 6},
    ])
    body = client.post("/api/planning/day?plan_date=2026-08-28").json()
    assert body["items"]
    for item in body["items"]:
        assert item["score_breakdown"]["components"]
        assert item["score_breakdown"]["frozen_from"] == "weekly_commitment"
        assert "daily_allocation" in item["score_breakdown"]


# --------------------------------------------------------- revealed preference


def test_user_action_is_recorded(client, portfolio):
    """§18/§32: revealed preference is the only real signal about utility."""
    client.post("/api/planning/commit",
                json=[{"trackable_id": 1, "committed_sessions": 10, "target_units": 100}])
    body = client.post("/api/planning/day?plan_date=2026-08-28").json()
    item_id = body["items"][0]["id"]

    updated = client.patch(f"/api/planning/plan-items/{item_id}",
                           json={"user_action": "deferred"}).json()
    assert updated["user_action"] == "deferred"

    bad = client.patch(f"/api/planning/plan-items/{item_id}", json={"user_action": "ignored"})
    assert bad.status_code == 422
