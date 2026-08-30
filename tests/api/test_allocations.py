"""Manual week shaping, and the completion timestamps the roadmap draws from.

The fallback test is the important one here. Manual placement is an override:
with no allocation rows the daily plan must come out exactly as §25.5's
arithmetic produced it before this feature existed. A regression there would
quietly change every user's plan without touching a line of planning code.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

import pytest
from fastapi.testclient import TestClient


def _monday(day: date) -> date:
    return day - timedelta(days=day.weekday())


TODAY = datetime.now(UTC).date()
THIS_MONDAY = _monday(TODAY)


@pytest.fixture
def committed(client: TestClient) -> dict:
    """One metered trackable and one session-budgeted milestone, committed."""
    client.post("/api/goals", json={
        "title": "Thesis", "kind": "goal", "definition_of_done": "Accepted",
        "activation": "active", "deadline": (TODAY + timedelta(days=120)).isoformat(),
        "stakes": 5,
    })
    client.post("/api/milestones", json={
        "goal_id": 1, "title": "Chapter three",
        "definition_of_done": "Draft sent to advisor",
    })
    client.post("/api/trackables", json={
        "milestone_id": 1, "title": "Ch3 draft", "unit": "pages",
        "total_units": 40, "total_units_source": "user_supplied",
        "task_type": "writing", "prior_pace": 2,
        "target_date": (TODAY + timedelta(days=60)).isoformat(),
    })
    client.post("/api/milestones", json={
        "goal_id": 1, "title": "Reading group",
        "definition_of_done": "Attended four sessions", "planned_sessions": 4,
    })
    client.post("/api/capacity", json={
        "week_start": THIS_MONDAY.isoformat(), "available_hours": 10,
    })
    client.put("/api/capacity/1/budgets", json={"goal_id": 1, "budgeted_sessions": 20})
    client.post("/api/planning/commit", json=[
        {"trackable_id": 1, "committed_sessions": 10, "target_units": 20},
        {"milestone_id": 2, "committed_sessions": 4},
    ])
    return {"trackable_id": 1, "milestone_id": 2}


# ------------------------------------------------------------------- fallback


def test_no_allocations_leaves_the_arithmetic_plan_untouched(
    client: TestClient, committed: dict
) -> None:
    """§25.5 remains the default. Manual placement is opt-in per week."""
    plan = client.post(f"/api/planning/day?plan_date={TODAY.isoformat()}").json()
    assert plan["manually_allocated"] is False
    for item in plan["items"]:
        assert item["score_breakdown"]["daily_allocation"].get("source") != "manual"


# ------------------------------------------------------------------- placement


def test_placed_sessions_drive_the_day_and_survive_regeneration(
    client: TestClient, committed: dict
) -> None:
    """POST /planning/day deletes and rewrites plan items, which is exactly why
    allocations live in their own table rather than as a flag on plan_item."""
    client.put("/api/planning/allocations", json={
        "week_start": THIS_MONDAY.isoformat(),
        "allocations": [
            {"trackable_id": 1, "plan_date": TODAY.isoformat(), "sessions": 3},
            {"milestone_id": 2, "plan_date": TODAY.isoformat(), "sessions": 1},
        ],
    })

    for _ in range(2):
        plan = client.post(f"/api/planning/day?plan_date={TODAY.isoformat()}").json()
        assert plan["manually_allocated"] is True
        by_target = {
            ("t" if i["trackable_id"] else "m"): i["score_breakdown"]["daily_allocation"]
            for i in plan["items"]
        }
        # Sessions convert to units at the week's own committed rate (20/10),
        # which is the user's declaration, not an estimate the system invented.
        assert by_target["t"]["per_day"] == pytest.approx(6.0)
        assert by_target["t"]["placed_sessions"] == 3
        assert by_target["m"]["per_day"] == pytest.approx(1.0)
        assert by_target["m"]["source"] == "manual"


def test_the_week_not_fitting_survives_the_user_shaping_it(
    client: TestClient, committed: dict
) -> None:
    """D9. Whether the week fits is a fact about the week, not about how its
    sessions were arranged, so the rebaseline signal must not be silenced by
    the user placing them differently."""
    client.put("/api/planning/allocations", json={
        "week_start": THIS_MONDAY.isoformat(),
        "allocations": [{"trackable_id": 1, "plan_date": TODAY.isoformat(), "sessions": 9}],
    })
    plan = client.post(f"/api/planning/day?plan_date={TODAY.isoformat()}").json()
    alloc = next(
        i["score_breakdown"]["daily_allocation"] for i in plan["items"] if i["trackable_id"]
    )
    assert alloc["manual_over_cap"] is True
    assert "capped" in alloc


def test_allocations_report_what_is_unplaced_and_what_is_overloaded(
    client: TestClient, committed: dict
) -> None:
    """Warnings, never refusals (D11): say what it costs, then do it."""
    body = client.put("/api/planning/allocations", json={
        "week_start": THIS_MONDAY.isoformat(),
        "allocations": [{"trackable_id": 1, "plan_date": TODAY.isoformat(), "sessions": 2}],
    }).json()

    kinds = {w["kind"] for w in body["warnings"]}
    assert "placement_mismatch" in kinds
    mismatch = next(w for w in body["warnings"] if w["kind"] == "placement_mismatch")
    assert (mismatch["placed_sessions"], mismatch["committed_sessions"]) == (2, 10)

    commitment = next(c for c in body["commitments"] if c["trackable_id"] == 1)
    assert commitment["placed_sessions"] == 2
    assert commitment["label"] == "Ch3 draft"


def test_allocations_outside_the_week_are_refused(client: TestClient, committed: dict) -> None:
    r = client.put("/api/planning/allocations", json={
        "week_start": THIS_MONDAY.isoformat(),
        "allocations": [{
            "trackable_id": 1,
            "plan_date": (THIS_MONDAY + timedelta(days=9)).isoformat(),
            "sessions": 1,
        }],
    })
    assert r.status_code == 422
    assert "outside the week" in r.json()["detail"]


def test_zero_session_placements_are_dropped_not_stored(
    client: TestClient, committed: dict
) -> None:
    """Removing a block is the absence of a row, not a row saying zero."""
    body = client.put("/api/planning/allocations", json={
        "week_start": THIS_MONDAY.isoformat(),
        "allocations": [
            {"trackable_id": 1, "plan_date": TODAY.isoformat(), "sessions": 0},
            {"milestone_id": 2, "plan_date": TODAY.isoformat(), "sessions": 2},
        ],
    }).json()
    assert [a["sessions"] for a in body["allocations"]] == [2]


def test_allocations_are_isolated_per_account(client: TestClient, committed: dict) -> None:
    client.put("/api/planning/allocations", json={
        "week_start": THIS_MONDAY.isoformat(),
        "allocations": [{"trackable_id": 1, "plan_date": TODAY.isoformat(), "sessions": 3}],
    })
    # The first registration claims the legacy single-token workspace, so it
    # inherits the fixture's data. The second account is the real test.
    alice = client.post("/api/auth/register", json={
        "email": "alice-alloc@example.com", "password": "correct-horse-battery",
    }).json()["token"]
    client.headers["Authorization"] = f"Bearer {alice}"
    assert len(client.get("/api/planning/allocations").json()["allocations"]) == 1

    bob = client.post("/api/auth/register", json={
        "email": "bob-alloc@example.com", "password": "correct-horse-battery",
    }).json()["token"]
    client.headers["Authorization"] = f"Bearer {bob}"
    # Bob owns no capacity at all, so he cannot even address the week.
    assert client.get("/api/planning/allocations").status_code == 409


# ---------------------------------------------------------------- completed_at


def test_completion_is_stamped_and_cleared_on_reopen(client: TestClient, seeded: dict) -> None:
    """A stale completion date is worse than an absent one: absent reads as
    unknown, stale reads as fact."""
    milestone_id = seeded["milestone"]["id"]
    assert client.patch(f"/api/milestones/{milestone_id}", json={"status": "done"}).json()[
        "completed_at"
    ] is not None

    reopened = client.patch(f"/api/milestones/{milestone_id}", json={"status": "in_progress"})
    assert reopened.json()["completed_at"] is None


def test_restamping_a_finished_node_does_not_slide_its_date(
    client: TestClient, seeded: dict
) -> None:
    """Most PATCHes touch some other field. A completion date that drifted on
    every edit would be a record of nothing."""
    milestone_id = seeded["milestone"]["id"]
    first = client.patch(f"/api/milestones/{milestone_id}", json={"status": "done"}).json()
    again = client.patch(f"/api/milestones/{milestone_id}", json={"title": "Renamed"}).json()
    assert again["completed_at"] == first["completed_at"]
    assert again["title"] == "Renamed"


def test_trackable_status_is_writable_and_reaches_the_roadmap(
    client: TestClient, seeded: dict
) -> None:
    trackable_id = seeded["trackable"]["id"]
    assert client.patch(f"/api/trackables/{trackable_id}", json={"status": "done"}).status_code == 200

    roadmap = client.get("/api/dashboard/roadmap").json()
    row = roadmap["rows"][0]["children"][0]["children"][0]
    assert row["status"] == "done"
    assert row["completed_at"] is not None
    # §25.3: version 1 stays on screen alongside current, always.
    assert row["baselines"]["original"]["version"] == 1
