"""The intake interview and the write path it feeds (§22, D10/D11).

The model call itself is stubbed. What matters here is not what the model says
but what happens to what it says: that a proposal survives turns intact, that
approving it writes the whole tree or none of it, and above all that this second
write path is held to the same invariants as the manual forms.
"""

from __future__ import annotations

from fastapi.testclient import TestClient
from sqlalchemy import text

from optimus.api.llm.ingest import (
    IngestProposal,
    ProposedGap,
    ProposedGoal,
    ProposedMilestone,
    ProposedTrackable,
)


def _trackable(**kw) -> ProposedTrackable:
    base = {
        "key": "green-book", "title": "Green Book", "unit": "pages",
        "total_units": 380.0, "total_units_source": "user_supplied",
        "task_type": "reading", "prior_pace": 20.0, "target_date": "2026-12-01",
    }
    return ProposedTrackable(**{**base, **kw})


def _milestone(**kw) -> ProposedMilestone:
    base = {
        "key": "finish-green-book", "title": "Finish the Green Book",
        "definition_of_done": "All 380 pages read", "dod_source": "user_supplied",
        "trackables": [_trackable()],
    }
    return ProposedMilestone(**{**base, **kw})


def _goal(**kw) -> ProposedGoal:
    base = {
        "key": "q1-offer", "title": "Q1 quant offer",
        "definition_of_done": "A signed offer in Chicago",
        "dod_source": "user_supplied", "activation": "active",
        "deadline": "2027-02-01", "stakes": 5, "milestones": [_milestone()],
    }
    return ProposedGoal(**{**base, **kw})


def _proposal(**kw) -> IngestProposal:
    return IngestProposal(**{"goals": [_goal()], "gaps": [], "notes": "", **kw})


# ------------------------------------------------------------------ the interview


def test_status_reports_whether_the_interview_can_run(client: TestClient):
    """The UI asks before showing a conversation it cannot hold."""
    body = client.get("/api/intake/status").json()
    assert "available" in body


def test_turn_returns_503_without_a_key(client: TestClient, monkeypatch):
    """P2: better plainly offline than quietly worse."""
    from optimus.api import settings
    from optimus.api.llm import client as llm_client

    settings.get_settings.cache_clear()
    llm_client.get_client.cache_clear()
    monkeypatch.setenv("OPTIMUS_GEMINI_API_KEY", "")

    r = client.post("/api/intake/turn", json={"message": "hello"})
    assert r.status_code == 503

    settings.get_settings.cache_clear()
    llm_client.get_client.cache_clear()


def test_a_turn_carries_the_proposal_forward(client: TestClient, monkeypatch):
    """Stability is the product requirement: the tree must not be rebuilt."""
    from optimus.api.llm import intake as intake_llm
    from optimus.api.llm.intake import InterviewTurn

    seen: dict = {}

    def fake_next_turn(history, current, user_message, today):
        seen["current"] = current
        seen["message"] = user_message
        return InterviewTurn(
            reply="Understood. When is that due?",
            proposal=current,  # unchanged: the model had nothing to add
            interview_complete=False,
        )

    monkeypatch.setattr(intake_llm, "next_turn", fake_next_turn)

    before = _proposal()
    r = client.post("/api/intake/turn", json={
        "message": "the deadline is February",
        "history": [{"role": "user", "content": "earlier"}],
        "proposal": before.model_dump(),
    })
    assert r.status_code == 200
    body = r.json()

    # The proposal reached the model and came back intact, keys included.
    assert seen["current"].goals[0].key == "q1-offer"
    assert body["proposal"]["goals"][0]["key"] == "q1-offer"
    assert body["proposal"]["goals"][0]["milestones"][0]["trackables"][0]["key"] == "green-book"
    assert body["persisted"] is False


def test_history_accumulates_both_sides_of_the_exchange(client: TestClient, monkeypatch):
    from optimus.api.llm import intake as intake_llm
    from optimus.api.llm.intake import InterviewTurn

    monkeypatch.setattr(
        intake_llm, "next_turn",
        lambda **kw: InterviewTurn(reply="Got it.", proposal=kw["current"], interview_complete=True),
    )

    body = client.post("/api/intake/turn", json={
        "message": "February 1st", "history": [], "proposal": _proposal().model_dump(),
    }).json()

    assert [m["role"] for m in body["history"]] == ["user", "assistant"]
    assert body["interview_complete"] is True


def test_remaining_questions_are_ranked_and_truncated(client: TestClient, monkeypatch):
    """§22.2: ask in priority order, stop below threshold. Do not walk the list."""
    from optimus.api.llm import intake as intake_llm
    from optimus.api.llm.intake import InterviewTurn

    noisy = _proposal(gaps=[
        ProposedGap(key=f"g{i}", question=f"q{i}", priority=float(i),
                    subject="q1-offer", why_it_matters="...")
        for i in range(1, 12)
    ])
    monkeypatch.setattr(
        intake_llm, "next_turn",
        lambda **kw: InterviewTurn(reply="?", proposal=noisy, interview_complete=False),
    )

    body = client.post("/api/intake/turn", json={
        "message": "x", "proposal": _proposal().model_dump(),
    }).json()

    priorities = [q["priority"] for q in body["remaining_questions"]]
    assert priorities == sorted(priorities, reverse=True)
    assert len(priorities) <= 7          # max_questions_per_session
    assert all(p >= 1.5 for p in priorities)  # min_priority_to_ask


# --------------------------------------------------------------------- approving


def test_approve_writes_the_whole_tree(client: TestClient, db_session):
    body = client.post("/api/intake/approve", json={"proposal": _proposal().model_dump()})
    assert body.status_code == 201
    created = body.json()["created"]
    assert created["goals"] == 1
    assert created["milestones"] == 1
    assert created["trackables"] == 1
    # §24.2 and §24.4 both need a baseline, and v1 is retained forever (§25.3).
    assert created["baselines"] == 1

    counts = db_session.exec(text(
        "SELECT (SELECT count(*) FROM goal), (SELECT count(*) FROM milestone), "
        "(SELECT count(*) FROM trackable), (SELECT count(*) FROM baseline)"
    )).one()
    assert tuple(counts) == (1, 1, 1, 1)


def test_approve_maps_proposal_keys_to_real_ids(client: TestClient):
    """The client was looking at keys; it needs to know what they became."""
    detail = client.post(
        "/api/intake/approve", json={"proposal": _proposal().model_dump()}
    ).json()["detail"]
    assert detail["goals"][0]["key"] == "q1-offer"
    assert detail["goals"][0]["id"] is not None


def test_baseline_is_sized_from_the_users_own_estimate(client: TestClient, db_session):
    """380 pages at a stated 20/session is 19 sessions, not a round guess."""
    client.post("/api/intake/approve", json={"proposal": _proposal().model_dump()})
    planned = db_session.exec(text("SELECT planned_sessions FROM baseline")).one()[0]
    assert planned == 19


def test_a_trackable_inherits_a_deadline_when_it_names_none(client: TestClient, db_session):
    """A trackable with no baseline has no drift and no required pace.

    The model routinely gives a goal a deadline without repeating it on every
    node beneath. Inheriting downward is what keeps those trackables measurable
    instead of merely logged.
    """
    proposal = _proposal(goals=[_goal(deadline="2027-02-01", milestones=[
        _milestone(deadline=None, trackables=[_trackable(target_date=None)])
    ])])
    assert client.post(
        "/api/intake/approve", json={"proposal": proposal.model_dump()}
    ).status_code == 201

    row = db_session.exec(text("SELECT target_date, planned_sessions FROM baseline")).one()
    assert str(row[0]) == "2027-02-01"   # inherited from the goal
    assert row[1] == 19                  # 380 pages at the user's stated 20/session


def test_approve_rejects_an_empty_proposal(client: TestClient):
    r = client.post("/api/intake/approve", json={"proposal": IngestProposal().model_dump()})
    assert r.status_code == 422


# ------------------------------------------------- the invariants, via this path


def test_ac01_holds_through_the_intake_path(client: TestClient, db_session):
    """An active goal with no deadline is refused here too, not silently parked.

    This is the reason check_activation was extracted rather than reimplemented:
    a second write path that skipped it would make AC1 decorative.
    """
    bad = _proposal(goals=[_goal(deadline=None, activation="active")])
    r = client.post("/api/intake/approve", json={"proposal": bad.model_dump()})

    assert r.status_code == 422
    assert "deadline" in r.json()["detail"].lower()
    assert db_session.exec(text("SELECT count(*) FROM goal")).one()[0] == 0


def test_ac18_holds_through_the_intake_path(client: TestClient, db_session):
    """A model-estimated total creates its open_gap in the same transaction."""
    estimated = _proposal(goals=[_goal(milestones=[
        _milestone(trackables=[_trackable(total_units_source="model_estimated")])
    ])])
    r = client.post("/api/intake/approve", json={"proposal": estimated.model_dump()})
    assert r.status_code == 201

    gap = db_session.exec(text(
        "SELECT trackable_id, priority, status FROM open_gap WHERE trackable_id IS NOT NULL"
    )).one()
    assert gap[0] is not None
    assert gap[1] == 5.0        # carried by the goal's stakes (§15.3)
    assert gap[2] == "open"     # and it resurfaces at review


def test_a_failure_anywhere_rolls_back_everything(client: TestClient, db_session):
    """A half-written goal graph is worse than none.

    The second goal is invalid; the first must not survive it. Feasibility and
    ranking read the graph as a whole, so a partial write produces confident
    numbers about a plan the user never approved.
    """
    proposal = _proposal(goals=[
        _goal(),
        _goal(key="thesis", title="Thesis", deadline=None, activation="active"),
    ])
    r = client.post("/api/intake/approve", json={"proposal": proposal.model_dump()})
    assert r.status_code == 422

    for table in ("goal", "milestone", "trackable", "baseline", "open_gap"):
        count = db_session.exec(text(f"SELECT count(*) FROM {table}")).one()[0]
        assert count == 0, f"{table} kept rows from a rolled-back approval"


def test_a_parked_goal_needs_no_deadline(client: TestClient):
    """§12: parking is where an intention belongs, and it is always allowed."""
    parked = _proposal(goals=[_goal(deadline=None, activation="parked")])
    assert client.post(
        "/api/intake/approve", json={"proposal": parked.model_dump()}
    ).status_code == 201


def test_a_recurring_commitment_can_be_active_without_a_date(client: TestClient, db_session):
    """§12: "gym six days a week has a deadline every week".

    Recurring commitments are recurring deadlines, "not an exception". The
    original CHECK demanded an absolute date of every active non-vision goal,
    which made the entire recurring category impossible to activate -- the model
    proposed exactly this from a real brain dump and the write path refused it.
    """
    gym = _proposal(goals=[_goal(
        key="gym", title="Gym six days a week",
        definition_of_done="Six sessions in the week", deadline=None,
        activation="active", pace_mode="reset_period", reset_period_days=7,
        milestones=[],
    )])
    assert client.post(
        "/api/intake/approve", json={"proposal": gym.model_dump()}
    ).status_code == 201

    row = db_session.exec(text(
        "SELECT activation, deadline, pace_mode, reset_period_days FROM goal"
    )).one()
    assert row[0] == "active"
    assert row[1] is None          # no absolute date...
    assert row[2] == "reset_period" and row[3] == 7   # ...because the window is the deadline


def test_a_non_recurring_goal_still_needs_a_date(client: TestClient):
    """The exemption is narrow: it does not weaken AC1 for ordinary goals."""
    r = client.post("/api/intake/approve", json={"proposal": _proposal(
        goals=[_goal(deadline=None, activation="active", pace_mode="carry_forward")]
    ).model_dump()})
    assert r.status_code == 422


def test_reset_period_without_a_period_is_still_refused(client: TestClient):
    """A pace_mode alone is not a deadline; the period is what makes it one."""
    r = client.post("/api/intake/approve", json={"proposal": _proposal(
        goals=[_goal(deadline=None, activation="active",
                     pace_mode="reset_period", reset_period_days=None)]
    ).model_dump()})
    assert r.status_code == 422


def test_exploratory_milestones_persist_without_units(client: TestClient, db_session):
    """§10: work with no natural counter is budgeted in sessions, not fake units."""
    proposal = _proposal(goals=[_goal(milestones=[
        _milestone(key="referrals", title="Secure two referrals",
                   definition_of_done="Two people have agreed in writing",
                   exploratory=True, planned_sessions=6, trackables=[])
    ])])
    assert client.post(
        "/api/intake/approve", json={"proposal": proposal.model_dump()}
    ).status_code == 201

    row = db_session.exec(text(
        "SELECT exploratory, planned_sessions FROM milestone"
    )).one()
    assert row[0] is True and row[1] == 6
    assert db_session.exec(text("SELECT count(*) FROM trackable")).one()[0] == 0


# -------------------------------------------------------------------------- tree


def test_tree_returns_the_hierarchy(client: TestClient):
    client.post("/api/intake/approve", json={"proposal": _proposal().model_dump()})
    tree = client.get("/api/tree").json()

    goal = tree["goals"][0]
    assert goal["title"] == "Q1 quant offer"
    assert goal["activation"] == "active"
    milestone = goal["children"][0]
    assert milestone["kind"] == "milestone"
    trackable = milestone["children"][0]
    assert trackable["kind"] == "trackable"
    assert trackable["fraction"] == 0.0
    # D3: provenance travels with the node so the diagram can flag it.
    assert trackable["total_units_source"] == "user_supplied"


def test_tree_of_an_empty_database_is_empty_not_an_error(client: TestClient):
    assert client.get("/api/tree").json() == {"goals": []}


def test_tree_does_not_query_per_node(client: TestClient, db_session):
    """Three queries regardless of size -- this renders a diagram, not a report."""
    for i in range(4):
        p = _proposal(goals=[_goal(key=f"g{i}", title=f"Goal {i}")])
        client.post("/api/intake/approve", json={"proposal": p.model_dump()})

    from sqlalchemy import event

    from optimus.api.db import get_engine

    queries: list[str] = []
    engine = get_engine()

    def count(conn, cursor, statement, *args):
        if statement.strip().upper().startswith("SELECT"):
            queries.append(statement)

    event.listen(engine, "before_cursor_execute", count)
    try:
        tree = client.get("/api/tree").json()
    finally:
        event.remove(engine, "before_cursor_execute", count)

    assert len(tree["goals"]) == 4
    assert len(queries) == 3, f"expected 3 selects, got {len(queries)}"
