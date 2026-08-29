"""vision.md §29 acceptance tests that are claims about persistence.

The engine-level criteria live in test_engine_acceptance.py. These six need a
real database because that is where the guarantee is enforced.
"""

from __future__ import annotations

import json

from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from tests.db_fixtures import log_session

# --------------------------------------------------------------------- AC 1


def test_ac01_goal_cannot_be_activated_without_dod_and_deadline(client: TestClient):
    """"A goal cannot be activated without a definition of done and a deadline." """
    # No deadline.
    r = client.post("/api/goals", json={
        "title": "Q1 offer", "kind": "goal",
        "definition_of_done": "Signed offer", "activation": "active", "stakes": 5,
    })
    assert r.status_code == 422
    assert "deadline" in r.json()["detail"].lower()

    # No definition of done -- rejected before it reaches the database.
    r = client.post("/api/goals", json={
        "title": "Q1 offer", "kind": "goal", "definition_of_done": "",
        "activation": "active", "deadline": "2027-02-01", "stakes": 5,
    })
    assert r.status_code == 422

    # Both present: accepted.
    r = client.post("/api/goals", json={
        "title": "Q1 offer", "kind": "goal", "definition_of_done": "Signed offer",
        "activation": "active", "deadline": "2027-02-01", "stakes": 5,
    })
    assert r.status_code == 201


def test_ac01_a_vision_may_be_active_without_a_deadline(client: TestClient):
    """§9: a vision is directional and unbounded, so the deadline rule exempts it.

    This is FIX 1 -- §21's CHECK as written made an active vision impossible.
    """
    r = client.post("/api/goals", json={
        "title": "An exciting quantitative career", "kind": "vision",
        "definition_of_done": "Directional -- never complete",
        "activation": "active", "stakes": 5,
    })
    assert r.status_code == 201
    assert r.json()["deadline"] is None


def test_parked_goals_need_no_deadline(client: TestClient):
    """§12: a goal with no deadline is an intention, and parking is where it lives."""
    r = client.post("/api/goals", json={
        "title": "Learn Rust", "kind": "goal",
        "definition_of_done": "Ship one CLI tool", "activation": "parked", "stakes": 2,
    })
    assert r.status_code == 201


# --------------------------------------------------------------------- AC 7


def test_ac07_completed_units_always_equals_sum_of_actual_output(
    client: TestClient, seeded: dict, db_session
):
    """"completed_units always equals SUM(actual_output)."

    Enforced by a database trigger, so no write path can forget it.
    """
    tid = seeded["trackable"]["id"]

    def invariant_holds() -> bool:
        row = db_session.exec(text(f"""
            SELECT completed_units
                   = COALESCE((SELECT SUM(actual_output) FROM work_session
                               WHERE trackable_id = {tid}), 0)
              FROM trackable WHERE id = {tid}
        """)).one()
        return bool(row[0])

    assert invariant_holds()

    log_session(client, tid, 30)
    db_session.commit()
    assert invariant_holds()

    # A retroactive entry, a correction, and a deletion each keep it true.
    retro = client.post("/api/sessions", json={
        "trackable_id": tid, "started_at": "2026-08-26T09:00:00Z", "actual_output": 12,
    }).json()
    db_session.commit()
    assert invariant_holds()

    db_session.exec(text(f"UPDATE work_session SET actual_output = 20 WHERE id = {retro['id']}"))
    db_session.commit()
    assert invariant_holds()

    db_session.exec(text(f"DELETE FROM work_session WHERE id = {retro['id']}"))
    db_session.commit()
    assert invariant_holds()

    total = db_session.exec(text(f"SELECT completed_units FROM trackable WHERE id={tid}")).one()
    assert total[0] == 30


# -------------------------------------------------------------------- AC 12


def test_ac12_every_rebaseline_retains_version_one(client: TestClient, seeded: dict):
    """"Every rebaseline retains version 1 and displays it alongside current." """
    tid = seeded["trackable"]["id"]
    assert seeded["baseline"]["version"] == 1

    for i, (resolution, sessions, target) in enumerate(
        [("cut_scope", 24, "2026-12-15"), ("add_sessions", 30, "2026-12-15")], start=2
    ):
        r = client.post(
            f"/api/baselines/rebaseline?trackable_id={tid}",
            json={
                "resolution": resolution, "rationale": f"reason {i}",
                "planned_sessions": sessions, "target_date": target,
            },
        )
        assert r.status_code == 201
        body = r.json()
        # v1 comes back with every rebaseline, so the UI cannot fail to show it.
        assert body["original"]["version"] == 1
        assert body["original"]["planned_sessions"] == 20
        assert body["current"]["version"] == i

    history = client.get(f"/api/trackables/{tid}/baselines").json()
    assert [h["version"] for h in history["history"]] == [1, 2, 3]
    assert history["original"]["planned_sessions"] == 20  # still says twenty
    assert history["current"]["planned_sessions"] == 30


def test_a_rebaseline_requires_a_reason(client: TestClient, seeded: dict):
    """§25.3: every rebaseline is versioned WITH a rationale. No silent drift."""
    tid = seeded["trackable"]["id"]
    r = client.post(
        f"/api/baselines/rebaseline?trackable_id={tid}",
        json={"resolution": "move_deadline", "rationale": "",
              "planned_sessions": 25, "target_date": "2027-01-01"},
    )
    assert r.status_code == 422


def test_rebaseline_rejects_an_invented_resolution(client: TestClient, seeded: dict):
    """§17 permits exactly four resolutions."""
    tid = seeded["trackable"]["id"]
    r = client.post(
        f"/api/baselines/rebaseline?trackable_id={tid}",
        json={"resolution": "just_ignore_it", "rationale": "hoping",
              "planned_sessions": 25, "target_date": "2027-01-01"},
    )
    assert r.status_code == 422


def test_moving_the_deadline_is_never_offered_as_a_default(client: TestClient):
    """§17: the system must never default to option 3."""
    body = client.get("/api/baselines/options").json()
    assert body["default"] is None
    assert body["options"][0] != "move_deadline"


# -------------------------------------------------------------------- AC 13


def test_ac13_plan_item_requires_a_non_empty_score_breakdown(
    client: TestClient, seeded: dict, db_session
):
    """"Every plan item has a non-empty score_breakdown."

    Enforced by a CHECK, so a degraded row cannot be written at all. P3: the
    breakdown is the only way to answer "why this?", and it is Part IV's
    training set -- an empty one is a bug, not a tolerable row.
    """
    import psycopg
    import pytest

    db_session.exec(text(
        "INSERT INTO daily_plan (plan_date, generated_at, capacity_minutes) "
        "VALUES ('2026-08-28', now(), 150)"
    ))
    db_session.commit()
    tid = seeded["trackable"]["id"]

    insert = text(
        "INSERT INTO plan_item (daily_plan_id, trackable_id, tier, score, "
        "score_breakdown, rank) VALUES (1, :tid, 'A', 0.5, CAST(:bd AS jsonb), 1)"
    )

    with pytest.raises((psycopg.errors.CheckViolation, SQLAlchemyError)):
        db_session.exec(insert, params={"tid": tid, "bd": "{}"})
        db_session.commit()
    db_session.rollback()

    # A populated breakdown is accepted.
    db_session.exec(
        insert,
        params={
            "tid": tid,
            "bd": json.dumps({
                "score": 0.5,
                "components": [
                    {"name": "urgency", "raw": 3, "normalized": 0.9,
                     "weight": 0.2, "contribution": 0.18}
                ],
            }),
        },
    )
    db_session.commit()

    stored = db_session.exec(text("SELECT score_breakdown FROM plan_item")).one()[0]
    assert stored["components"], "the breakdown must survive the round trip intact"


# -------------------------------------------------------------------- AC 16


def test_ac16_skipping_the_slider_writes_no_row(client: TestClient, seeded: dict, db_session):
    """"Skipping the slider takes one tap and writes no progress_check row."

    D12: skipping must be the path of least resistance, because a forced slider
    produces invented numbers.
    """
    tid = seeded["trackable"]["id"]

    result = log_session(client, tid, 30)  # no self_assessed_pct supplied
    assert result["progress_check_created"] is None
    assert db_session.exec(text("SELECT count(*) FROM progress_check")).one()[0] == 0

    result = log_session(client, tid, 30, self_assessed_pct=25)
    assert result["progress_check_created"] is not None
    assert db_session.exec(text("SELECT count(*) FROM progress_check")).one()[0] == 1


# -------------------------------------------------------------------- AC 17


def test_ac17_retroactive_session_counts_fully_toward_progress_and_pace(
    client: TestClient, seeded: dict
):
    """"A retroactive session contributes fully to completed_units and pace_hat,
    and at the configured weight to calibration." """
    tid = seeded["trackable"]["id"]

    before = client.get(f"/api/trackables/{tid}").json()
    row = client.post("/api/sessions", json={
        "trackable_id": tid, "started_at": "2026-08-26T09:00:00Z", "actual_output": 15,
    }).json()
    assert row["entered_retroactively"] is True

    after = client.get(f"/api/trackables/{tid}").json()
    # Full weight in progress...
    assert after["progress"]["completed_units"] == before["progress"]["completed_units"] + 15
    # ...and full weight in pace.
    assert after["pace"]["n_sessions"] == before["pace"]["n_sessions"] + 1
    # ...but it is reported in the retroactive distribution for calibration (D13).
    assert len(after["calibration"]["retroactive_ratios"]) == 1


# -------------------------------------------------------------------- AC 18


def test_ac18_model_estimated_units_always_create_an_open_gap(
    client: TestClient, seeded: dict, db_session
):
    """"The ingestion pipeline never writes a model_estimated total_units without
    also creating an open_gap row."

    This is FIX 2: §21's open_gap had no trackable_id, which made the guarantee
    unrecordable against the thing it is about.
    """
    mid = seeded["milestone"]["id"]

    r = client.post("/api/trackables", json={
        "milestone_id": mid, "title": "Some paper", "unit": "pages",
        "total_units": 120, "total_units_source": "model_estimated",
        "task_type": "reading",
    }).json()
    assert r["open_gap_created"] is not None

    gap = db_session.exec(text(
        f"SELECT trackable_id, priority, status FROM open_gap "
        f"WHERE id = {r['open_gap_created']}"
    )).one()
    assert gap[0] == r["trackable"]["id"]
    assert gap[1] > 0            # stakes x uncertainty
    assert gap[2] == "open"      # and it resurfaces at review

    # A user-supplied total needs no gap: nothing was guessed.
    r2 = client.post("/api/trackables", json={
        "milestone_id": mid, "title": "Known book", "unit": "pages",
        "total_units": 200, "total_units_source": "user_supplied",
        "task_type": "reading",
    }).json()
    assert r2["open_gap_created"] is None
