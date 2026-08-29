"""Session logging behaviour (§23).

P5 makes logging cost a first-order design constraint, not a UX detail: every
metric is downstream of the user logging what happened, so if logging is
annoying the data degrades and every derived number becomes fiction. These
tests pin the interaction cost, not just the correctness.
"""

from __future__ import annotations

from fastapi.testclient import TestClient


def test_ending_a_session_takes_one_input(client: TestClient, seeded: dict):
    """§23.2: one input, prefilled with the expected value."""
    tid = seeded["trackable"]["id"]
    started = client.post("/api/sessions/start", json={"trackable_id": tid}).json()

    # Everything else is prefilled at start time.
    assert started["planned_minutes"] == 25
    assert started["expected_output"] == 20.0  # from prior_pace, via pace_hat
    assert started["task_type"] == "reading"

    ended = client.post(f"/api/sessions/{started['id']}/end", json={"actual_output": 9}).json()
    assert ended["session"]["actual_output"] == 9


def test_confirming_the_prefilled_value_is_one_tap(client: TestClient, seeded: dict):
    """Omitting actual_output means "the expectation was right"."""
    tid = seeded["trackable"]["id"]
    started = client.post("/api/sessions/start", json={"trackable_id": tid}).json()

    ended = client.post(f"/api/sessions/{started['id']}/end", json={}).json()
    assert ended["session"]["actual_output"] == started["expected_output"]


def test_expected_output_comes_from_pace_not_a_fixed_guess(client: TestClient, seeded: dict):
    """§23.4. As observations accumulate, the prefill tracks reality."""
    tid = seeded["trackable"]["id"]

    first = client.post("/api/sessions/start", json={"trackable_id": tid}).json()
    assert first["expected_output"] == 20.0  # the user's optimistic prior
    client.post(f"/api/sessions/{first['id']}/end", json={"actual_output": 9})

    for _ in range(5):
        s = client.post("/api/sessions/start", json={"trackable_id": tid}).json()
        client.post(f"/api/sessions/{s['id']}/end", json={"actual_output": 9})

    later = client.post("/api/sessions/start", json={"trackable_id": tid}).json()
    assert later["expected_output"] < 20.0  # shrunk toward the observed 9


def test_the_open_session_survives_losing_the_client(client: TestClient, seeded: dict):
    """Timer state lives in the row, not the browser.

    Closing the tab or switching to the phone must not lose an in-flight
    session -- if it did, the honest response would be to stop logging.
    """
    tid = seeded["trackable"]["id"]
    started = client.post("/api/sessions/start", json={"trackable_id": tid}).json()

    resumed = client.get("/api/sessions/open").json()
    assert resumed["id"] == started["id"]
    assert resumed["ended_at"] is None

    client.post(f"/api/sessions/{started['id']}/end", json={"actual_output": 9})
    assert client.get("/api/sessions/open").json() is None


def test_two_sessions_cannot_run_at_once(client: TestClient, seeded: dict):
    """A second timer would make actual_minutes meaningless for both."""
    tid = seeded["trackable"]["id"]
    client.post("/api/sessions/start", json={"trackable_id": tid})
    second = client.post("/api/sessions/start", json={"trackable_id": tid})
    assert second.status_code == 409


def test_a_session_cannot_be_ended_twice(client: TestClient, seeded: dict):
    tid = seeded["trackable"]["id"]
    started = client.post("/api/sessions/start", json={"trackable_id": tid}).json()
    client.post(f"/api/sessions/{started['id']}/end", json={"actual_output": 9})
    again = client.post(f"/api/sessions/{started['id']}/end", json={"actual_output": 9})
    assert again.status_code == 409


def test_interrupted_is_one_toggle_and_the_row_is_kept(client: TestClient, seeded: dict):
    """§23.6: excluded from pace, retained. The work still happened."""
    tid = seeded["trackable"]["id"]
    started = client.post("/api/sessions/start", json={"trackable_id": tid}).json()
    client.post(f"/api/sessions/{started['id']}/end",
                json={"actual_output": 2, "interrupted": True})

    view = client.get(f"/api/trackables/{tid}").json()
    assert view["pace"]["n_sessions"] == 0          # excluded from pace
    assert view["progress"]["completed_units"] == 2  # but the work is recorded

    sessions = client.get("/api/sessions").json()
    assert len(sessions) == 1 and sessions[0]["interrupted"] is True


def test_a_session_needs_something_to_attach_to(client: TestClient):
    assert client.post("/api/sessions/start", json={}).status_code == 422


def test_unauthenticated_requests_are_refused(seeded: dict):
    """§19: the token is the only thing between the internet and this data."""
    from optimus.api.main import app

    with TestClient(app) as anon:
        assert anon.get("/api/trackables").status_code == 401
        assert anon.post("/api/sessions/start", json={"trackable_id": 1}).status_code == 401
        # Health stays open so the platform can probe it.
        assert anon.get("/api/health").status_code == 200
