"""Session logging behaviour (§23).

P5 makes logging cost a first-order design constraint, not a UX detail: every
metric is downstream of the user logging what happened, so if logging is
annoying the data degrades and every derived number becomes fiction. These
tests pin the interaction cost, not just the correctness.
"""

from __future__ import annotations

import pytest
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


def test_a_session_can_start_attached_to_nothing(client: TestClient):
    """Work does not always arrive with a goal tree already built around it, and
    refusing to time it until one exists is the tool asking to be served. The
    session is inert until the interview turns its description into a tree."""
    started = client.post("/api/sessions/start", json={}).json()
    assert started["trackable_id"] is None
    assert started["milestone_id"] is None
    assert started["task_type"] == "exploratory"
    # No trackable means no expectation, which is what keeps it out of pace.
    assert started["expected_output"] is None


def test_an_untagged_session_declares_its_own_task_type(client: TestClient):
    started = client.post("/api/sessions/start", json={"task_type": "writing"}).json()
    assert started["task_type"] == "writing"


def test_an_invented_task_type_is_refused(client: TestClient):
    r = client.post("/api/sessions/start", json={"task_type": "napping"})
    assert r.status_code == 422


def test_unauthenticated_requests_are_refused(seeded: dict):
    """§19: the token is the only thing between the internet and this data."""
    from optimus.api.main import app

    with TestClient(app) as anon:
        assert anon.get("/api/trackables").status_code == 401
        assert anon.post("/api/sessions/start", json={"trackable_id": 1}).status_code == 401
        # Health stays open so the platform can probe it.
        assert anon.get("/api/health").status_code == 200


def test_reported_flow_time_is_stored_verbatim(client: TestClient, seeded: dict):
    """The client watched the countdown cross zero; the server did not.

    A session ended a few seconds after it started has essentially no wall-clock
    overrun, so if the reported value were ignored in favour of the derived one
    this would come back as zero.
    """
    tid = seeded["trackable"]["id"]
    started = client.post("/api/sessions/start", json={"trackable_id": tid}).json()

    ended = client.post(
        f"/api/sessions/{started['id']}/end", json={"flow_minutes": 12.5}
    ).json()
    assert ended["session"]["flow_minutes"] == 12.5


def test_flow_time_falls_back_to_the_overrun_and_never_goes_negative(
    client: TestClient, seeded: dict
):
    """Ending from a surface that never showed a countdown still records flow.

    The desktop pill and the phone both end sessions without having watched the
    boundary, and a session that stopped early crossed nothing -- so the floor
    at zero is the whole point, not defensive padding.
    """
    tid = seeded["trackable"]["id"]
    started = client.post("/api/sessions/start", json={"trackable_id": tid}).json()

    ended = client.post(f"/api/sessions/{started['id']}/end", json={}).json()["session"]
    assert ended["actual_minutes"] < ended["planned_minutes"]
    assert ended["flow_minutes"] == 0.0


def test_flow_endpoint_excludes_sessions_that_never_recorded_it(
    client: TestClient, seeded: dict
):
    """NULL is unknown, not zero, on both sides of the rate.

    Rows written before the column existed must not be counted as sessions that
    failed to reach flow -- that would manufacture a downward trend out of
    history the user never lived.
    """
    tid = seeded["trackable"]["id"]
    for minutes in (8.0, 0.0):
        s = client.post("/api/sessions/start", json={"trackable_id": tid}).json()
        client.post(f"/api/sessions/{s['id']}/end", json={"flow_minutes": minutes})

    payload = client.get("/api/dashboard/flow?weeks=2&tz=UTC").json()
    assert payload["total_flow_minutes"] == 8.0
    assert payload["sessions"] == 2
    assert payload["sessions_in_flow"] == 1
    assert payload["flow_rate"] == 0.5

    # And it is attributed to the goal the trackable hangs off.
    assert payload["goals"][0]["flow_minutes"] == 8.0
    assert payload["goals"][0]["flow_rate"] == 0.5


# ------------------------------------------------- §36.1 reversed: any length


def test_the_timer_length_is_the_users_to_set(client: TestClient, seeded: dict):
    """§36.1 reversed. Forcing an hour of work into consecutive 25-minute rows
    is bookkeeping the user performs on the system's behalf."""
    tid = seeded["trackable"]["id"]
    started = client.post(
        "/api/sessions/start", json={"trackable_id": tid, "planned_minutes": 50}
    ).json()
    assert started["planned_minutes"] == 50


def test_omitting_the_length_still_gets_the_default(client: TestClient, seeded: dict):
    tid = seeded["trackable"]["id"]
    started = client.post("/api/sessions/start", json={"trackable_id": tid}).json()
    assert started["planned_minutes"] == 25


def test_a_non_positive_duration_is_refused(client: TestClient, seeded: dict):
    tid = seeded["trackable"]["id"]
    r = client.post("/api/sessions/start", json={"trackable_id": tid, "planned_minutes": 0})
    assert r.status_code == 422


def test_expected_output_scales_with_the_session_length(client: TestClient, seeded: dict):
    """Otherwise §24.5 calibration measures the clock instead of the user: a
    50-minute session prefilled with a 25-minute expectation reports
    actual/expected near 2.0 every single time."""
    tid = seeded["trackable"]["id"]
    standard = client.post(
        "/api/sessions/start", json={"trackable_id": tid, "planned_minutes": 25}
    ).json()
    client.post(f"/api/sessions/{standard['id']}/end", json={})

    double = client.post(
        "/api/sessions/start", json={"trackable_id": tid, "planned_minutes": 50}
    ).json()
    assert double["expected_output"] == pytest.approx(standard["expected_output"] * 2, rel=0.02)


def test_session_defaults_offers_presets_without_making_them_a_whitelist(client: TestClient):
    body = client.get("/api/sessions/defaults").json()
    assert body["minutes"] == 25
    assert 50 in body["presets"]
    assert body["min_session_minutes"] > 0


# ------------------------------------------------- the second measurement axis


def test_the_secondary_cache_matches_the_sum_of_its_sessions(client: TestClient, seeded: dict):
    """The AC7 invariant, extended to the second axis. One trigger owns both
    caches, so neither can drift from what the sessions actually say."""
    tid = seeded["trackable"]["id"]
    for count in (3, 5, 2):
        s = client.post("/api/sessions/start", json={"trackable_id": tid}).json()
        client.post(
            f"/api/sessions/{s['id']}/end",
            json={"actual_output": 10, "secondary_output": count},
        )

    view = _trackable(client, tid)
    assert view["secondary_completed_units"] == 10.0


def test_deleting_and_moving_sessions_keeps_both_caches_honest(
    client: TestClient, seeded: dict
):
    """The branch most easily forgotten: a session that moves between trackables
    must refresh the one it LEFT as well as the one it joined."""
    first = seeded["trackable"]["id"]
    other = client.post("/api/trackables", json={
        "milestone_id": seeded["milestone"]["id"], "title": "Other", "unit": "pages",
        "total_units": 100, "task_type": "reading",
    }).json()["trackable"]["id"]

    s = client.post("/api/sessions/start", json={"trackable_id": first}).json()
    client.post(
        f"/api/sessions/{s['id']}/end", json={"actual_output": 9, "secondary_output": 4}
    )
    assert _trackable(client, first)["secondary_completed_units"] == 4.0

    client.post(f"/api/sessions/{s['id']}/attach", json={"trackable_id": other})

    assert _trackable(client, first)["secondary_completed_units"] == 0.0
    assert _trackable(client, other)["secondary_completed_units"] == 4.0
    # completed_units must have followed it too.
    assert _trackable(client, first)["progress"]["completed_units"] == 0.0
    assert _trackable(client, other)["progress"]["completed_units"] == 9.0


def test_confirming_a_count_names_the_unit_in_the_same_action(
    client: TestClient, seeded: dict
):
    tid = seeded["trackable"]["id"]
    s = client.post("/api/sessions/start", json={"trackable_id": tid}).json()
    client.post(f"/api/sessions/{s['id']}/end", json={"actual_output": 9})

    client.patch(
        f"/api/sessions/{s['id']}/reflection",
        json={"secondary_output": 8, "secondary_unit": "problems"},
    )
    view = _trackable(client, tid)
    assert view["secondary_unit"] == "problems"
    assert view["secondary_completed_units"] == 8.0


def test_a_declared_session_target_does_not_touch_the_prefilled_expectation(
    client: TestClient, seeded: dict
):
    """§23.4 governs the PRIMARY expectation, which must come from pace_hat. A
    target the user declares on the second axis feeds no calibration."""
    tid = seeded["trackable"]["id"]
    started = client.post(
        "/api/sessions/start",
        json={"trackable_id": tid, "target_secondary_output": 8},
    ).json()
    assert started["secondary_expected_output"] == 8
    assert started["expected_output"] == 20.0  # still the prior, untouched


def test_an_untagged_session_never_shapes_pace(client: TestClient, seeded: dict):
    """It has no trackable, so no expected_output, so no actual_output -- and
    SessionObs.counts_toward_pace is already False for such a row."""
    tid = seeded["trackable"]["id"]
    before = _trackable(client, tid)["pace"]["n_sessions"]

    s = client.post("/api/sessions/start", json={}).json()
    client.post(f"/api/sessions/{s['id']}/end", json={"note": "read some papers"})

    assert _trackable(client, tid)["pace"]["n_sessions"] == before


def test_analysis_needs_something_to_read(client: TestClient, seeded: dict):
    tid = seeded["trackable"]["id"]
    s = client.post("/api/sessions/start", json={"trackable_id": tid}).json()
    client.post(f"/api/sessions/{s['id']}/end", json={"actual_output": 9})
    assert client.post(f"/api/sessions/{s['id']}/analyze").status_code == 422


def test_ending_a_session_reports_whether_to_ask_what_happened(
    client: TestClient, seeded: dict
):
    """Computed from data already written -- no model call, nothing blocked, so
    ending stays one tap (§23.2)."""
    tid = seeded["trackable"]["id"]
    s = client.post("/api/sessions/start", json={"trackable_id": tid}).json()
    ended = client.post(f"/api/sessions/{s['id']}/end", json={"actual_output": 9}).json()

    assert "productivity" in ended
    assert ended["productivity"]["progress_outlier"] in (True, False)


def _trackable(client: TestClient, trackable_id: int) -> dict:
    rows = client.get("/api/trackables").json()
    rows = rows["data"] if isinstance(rows, dict) and "data" in rows else rows
    return next(r for r in rows if r["trackable_id"] == trackable_id)


def test_assigning_a_running_session_gives_it_an_expectation(client: TestClient, seeded: dict):
    """The start-first-assign-later flow. Without this the session ends with
    nothing to prefill and §23.2's one-tap confirm is gone."""
    tid = seeded["trackable"]["id"]
    started = client.post("/api/sessions/start", json={"planned_minutes": 25}).json()
    assert started["expected_output"] is None

    attached = client.post(
        f"/api/sessions/{started['id']}/attach", json={"trackable_id": tid}
    ).json()["session"]
    assert attached["expected_output"] == 20.0
    assert attached["task_type"] == "reading"


def test_attaching_a_finished_session_does_not_invent_a_prediction(
    client: TestClient, seeded: dict
):
    """§24.5 scores the user against what they predicted. Back-filling a
    prediction after the fact would manufacture the very thing being scored."""
    tid = seeded["trackable"]["id"]
    started = client.post("/api/sessions/start", json={}).json()
    client.post(f"/api/sessions/{started['id']}/end", json={"note": "read some papers"})

    attached = client.post(
        f"/api/sessions/{started['id']}/attach",
        json={"trackable_id": tid, "actual_output": 12},
    ).json()["session"]
    assert attached["expected_output"] is None
    assert attached["actual_output"] == 12


# ---------------------------------------------------------------- cancelling


def test_a_running_session_can_be_discarded(client: TestClient, seeded: dict):
    """A one-tap start produces starts that were not meant. The alternative to
    cancelling is ending them, which writes expected_output into actual_output
    as though the expectation had been met."""
    tid = seeded["trackable"]["id"]
    started = client.post("/api/sessions/start", json={"trackable_id": tid}).json()

    assert client.delete(f"/api/sessions/{started['id']}").status_code == 204
    assert client.get("/api/sessions/open").json() is None
    # And it left nothing behind that pace could read.
    assert _trackable(client, tid)["pace"]["n_sessions"] == 0


def test_cancelling_frees_the_slot_for_another_session(client: TestClient, seeded: dict):
    """Only one session may be open, so a mis-tap must not block the real one."""
    tid = seeded["trackable"]["id"]
    first = client.post("/api/sessions/start", json={"trackable_id": tid}).json()
    assert client.post("/api/sessions/start", json={"trackable_id": tid}).status_code == 409

    client.delete(f"/api/sessions/{first['id']}")
    assert client.post("/api/sessions/start", json={"trackable_id": tid}).status_code == 201


def test_a_finished_session_cannot_be_cancelled(client: TestClient, seeded: dict):
    """A logged fact is not an in-flight timer. Deleting one is a different act,
    and this endpoint deliberately cannot perform it."""
    tid = seeded["trackable"]["id"]
    started = client.post("/api/sessions/start", json={"trackable_id": tid}).json()
    client.post(f"/api/sessions/{started['id']}/end", json={"actual_output": 9})

    assert client.delete(f"/api/sessions/{started['id']}").status_code == 409
    assert _trackable(client, tid)["progress"]["completed_units"] == 9.0


def test_cancelling_withdraws_nothing_from_the_caches(client: TestClient, seeded: dict):
    """A real logged session's contribution must survive a later cancel of a
    different, unrelated one."""
    tid = seeded["trackable"]["id"]
    done = client.post("/api/sessions/start", json={"trackable_id": tid}).json()
    client.post(
        f"/api/sessions/{done['id']}/end",
        json={"actual_output": 9, "secondary_output": 3},
    )

    mistake = client.post("/api/sessions/start", json={"trackable_id": tid}).json()
    client.delete(f"/api/sessions/{mistake['id']}")

    view = _trackable(client, tid)
    assert view["progress"]["completed_units"] == 9.0
    assert view["secondary_completed_units"] == 3.0
