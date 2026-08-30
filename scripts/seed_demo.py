"""Seed a demo account in the local `optimus` database.

Everything goes through the public API so the same write rules that guard real
data guard this -- activation checks, the model_estimated gap, baseline
versioning. Two things are touched afterwards with SQL, both flagged inline:
they are properties the API deliberately does not let a caller set.

Safe to re-run: it deletes the demo account first, and RLS keeps it entirely
separate from any other account in the database.
"""

from __future__ import annotations

import json
import random
import urllib.error
import urllib.request
from datetime import UTC, date, datetime, timedelta

import psycopg

BASE = "http://127.0.0.1:8077"
DB = "dbname=optimus"
EMAIL = "demo@optimus.local"
PASSWORD = "demo-optimus-2026"

# The user's local day, matching how the app keys plans and capacity weeks.
TODAY = datetime.now().astimezone().date()
MONDAY = TODAY - timedelta(days=TODAY.weekday())
# The commitment grid defaults to a 26-week window. Seeding less than that
# leaves the left of the grid empty and, worse, makes every un-seeded week of a
# recurring commitment read as a MISSED window.
WEEKS = 27

random.seed(11)
TOKEN: str | None = None


def call(method: str, path: str, body=None):
    req = urllib.request.Request(BASE + path, method=method)
    req.add_header("Content-Type", "application/json")
    if TOKEN:
        req.add_header("Authorization", f"Bearer {TOKEN}")
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(req, data) as r:
            raw = r.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        raise SystemExit(f"{method} {path} -> {e.code}: {e.read().decode()[:300]}") from e


def iso(d: date, hour: int = 10) -> str:
    return datetime(d.year, d.month, d.day, hour, tzinfo=UTC).isoformat()


# ---------------------------------------------------------------- fresh start
with psycopg.connect(DB) as c:
    row = c.execute("select id from app_user where email = %s", (EMAIL,)).fetchone()
    if row:
        # ON DELETE CASCADE reaches every tenant table.
        c.execute("delete from app_user where id = %s", (row[0],))
        c.commit()
        print(f"removed previous demo account (user {row[0]})")

TOKEN = call("POST", "/api/auth/register", {"email": EMAIL, "password": PASSWORD})["token"]
with psycopg.connect(DB) as c:
    USER_ID = c.execute("select id from app_user where email = %s", (EMAIL,)).fetchone()[0]
print(f"demo account is user {USER_ID}")

for name in ("Professional", "Health", "Learning", "Life"):
    call("POST", "/api/areas", {"name": name})
# Area ids are global, not per-account, so read them back rather than assuming.
AREA = {a["name"]: a["id"] for a in call("GET", "/api/areas")}

# ------------------------------------------------------------------ the graph
g_offer = call("POST", "/api/goals", {
    "title": "Land a Quant Research Offer", "kind": "goal", "area_id": AREA["Professional"],
    "definition_of_done": "Signed offer from a systematic fund",
    "activation": "active", "deadline": (TODAY + timedelta(days=120)).isoformat(), "stakes": 5,
})
m_book = call("POST", "/api/milestones", {
    "goal_id": g_offer["id"], "title": "Finish the Green Book",
    "definition_of_done": "All 380 pages read, every problem attempted",
    "deadline": (TODAY + timedelta(days=60)).isoformat(),
})
t_book = call("POST", "/api/trackables", {
    "milestone_id": m_book["id"], "title": "Green Book", "unit": "pages",
    "total_units": 380, "total_units_source": "user_supplied", "task_type": "reading",
    "prior_pace": 14, "target_date": (TODAY + timedelta(days=60)).isoformat(),
})["trackable"]

# A baseline that was later cut back -- this is what draws the ghost bar.
call("POST", "/api/baselines", {
    "trackable_id": t_book["id"], "planned_sessions": 20,
    "target_date": (TODAY + timedelta(days=25)).isoformat(), "scope_units": 380,
})
call("POST", f"/api/baselines/rebaseline?trackable_id={t_book['id']}", {
    "resolution": "move_deadline",
    "rationale": "Twelve pages a session, not twenty. The original date assumed a pace I have never hit.",
    "planned_sessions": 26, "target_date": (TODAY + timedelta(days=60)).isoformat(),
    "scope_units": 380,
})

# Work with no natural counter: budgeted in sessions (§10), exploratory (D12).
m_refs = call("POST", "/api/milestones", {
    "goal_id": g_offer["id"], "title": "Secure Two Referrals",
    "definition_of_done": "Two people have agreed in writing to refer me",
    "planned_sessions": 6, "deadline": (TODAY + timedelta(days=30)).isoformat(),
    "exploratory": True,
})

g_thesis = call("POST", "/api/goals", {
    "title": "Master's Thesis, Chapter Three", "kind": "goal", "area_id": AREA["Learning"],
    "definition_of_done": "Draft accepted by my advisor without major revisions",
    "activation": "active", "deadline": (TODAY + timedelta(days=45)).isoformat(), "stakes": 4,
})
m_ch3 = call("POST", "/api/milestones", {
    "goal_id": g_thesis["id"], "title": "Chapter Three Draft",
    "definition_of_done": "Sent to advisor",
    "deadline": (TODAY + timedelta(days=40)).isoformat(),
})
# model_estimated: shows the warn tag everywhere, and opens a gap (AC18/D3).
t_ch3 = call("POST", "/api/trackables", {
    "milestone_id": m_ch3["id"], "title": "Ch3 Draft", "unit": "pages",
    "total_units": 40, "total_units_source": "model_estimated", "task_type": "writing",
    "prior_pace": 0.8, "target_date": (TODAY + timedelta(days=40)).isoformat(),
})["trackable"]
call("POST", "/api/baselines", {
    "trackable_id": t_ch3["id"], "planned_sessions": 30,
    "target_date": (TODAY + timedelta(days=40)).isoformat(), "scope_units": 40,
})

t_probs = call("POST", "/api/trackables", {
    "milestone_id": m_book["id"], "title": "Problem Sets", "unit": "problems",
    "total_units": 300, "total_units_source": "user_supplied", "task_type": "problems",
    "prior_pace": 3, "target_date": (TODAY + timedelta(days=60)).isoformat(),
})["trackable"]
call("POST", "/api/baselines", {
    "trackable_id": t_probs["id"], "planned_sessions": 100,
    "target_date": (TODAY + timedelta(days=60)).isoformat(), "scope_units": 300,
})

# A recurring commitment: the window closes weekly and the shortfall is discarded.
g_gym = call("POST", "/api/goals", {
    "title": "Train Six Days a Week", "kind": "goal", "area_id": AREA["Health"],
    "definition_of_done": "Six training sessions logged every week",
    "activation": "active", "pace_mode": "reset_period", "reset_period_days": 7, "stakes": 3,
})
m_gym = call("POST", "/api/milestones", {
    "goal_id": g_gym["id"], "title": "Weekly Training",
    "definition_of_done": "Six sessions this week",
})
t_gym = call("POST", "/api/trackables", {
    "milestone_id": m_gym["id"], "title": "Gym", "unit": "sessions",
    "total_units": 6, "total_units_source": "user_supplied", "task_type": "admin",
    "prior_pace": 1,
})["trackable"]

# Finished work, so the timeline has an actual bar to draw.
g_tax = call("POST", "/api/goals", {
    "title": "File 2025 Taxes", "kind": "goal", "area_id": AREA["Life"],
    "definition_of_done": "Return filed and acknowledged",
    "activation": "active", "deadline": (TODAY - timedelta(days=4)).isoformat(), "stakes": 5,
})
m_tax = call("POST", "/api/milestones", {
    "goal_id": g_tax["id"], "title": "File the Return",
    "definition_of_done": "Acknowledgement received", "planned_sessions": 3,
    "deadline": (TODAY - timedelta(days=4)).isoformat(),
})
call("PATCH", f"/api/milestones/{m_tax['id']}", {"status": "done"})
call("PATCH", f"/api/goals/{g_tax['id']}", {"status": "done"})

# Parked: visible everywhere, competing for nothing (§12).
call("POST", "/api/goals", {
    "title": "Learn Rust Properly", "kind": "goal", "area_id": AREA["Learning"],
    "definition_of_done": "Shipped one real tool I use daily", "activation": "parked", "stakes": 2,
})

# -------------------------------------------------------------------- history
def log(trackable_id=None, milestone_id=None, *, day, expected=None, actual=None,
        minutes=25, interrupted=False, intent_met=None, hour=10):
    body = {"started_at": iso(day, hour), "planned_minutes": 25,
            "actual_minutes": minutes, "interrupted": interrupted}
    if trackable_id:
        body["trackable_id"] = trackable_id
    if milestone_id:
        body["milestone_id"] = milestone_id
    if expected is not None:
        body["expected_output"] = expected
    if actual is not None:
        body["actual_output"] = actual
    if intent_met is not None:
        body["intent_met"] = intent_met
    call("POST", "/api/sessions", body)

# Which days each body of work was touched. Output is assigned afterwards from a
# target fraction, so the totals land where they should instead of the book
# quietly finishing in month two and leaving the recent weeks empty.
days_worked: dict[str, list[date]] = {"book": [], "probs": [], "ch3": [], "refs": []}
gym_days: list[date] = []

for week in range(WEEKS, -1, -1):
    monday = MONDAY - timedelta(weeks=week)
    # Solid early, patchier lately, so the period rows show met AND missed.
    gym_target = 6 if week > 10 else random.choice([6, 6, 6, 5, 6, 4])
    chosen = random.sample(range(6), min(gym_target, 6))

    for dow in range(7):
        day = monday + timedelta(days=dow)
        if day > TODAY:
            continue
        if dow in chosen:
            gym_days.append(day)
        if dow in (0, 3) and random.random() < 0.55:
            days_worked["book"].append(day)
        if dow < 5 and random.random() < 0.6:
            days_worked["probs"].append(day)
        if dow in (1, 4, 6) and random.random() < 0.55:
            days_worked["ch3"].append(day)
        if dow == 2 and random.random() < 0.35:
            days_worked["refs"].append(day)

def spread(total: float, n: int, jitter: float, quantise) -> list[float]:
    """n session outputs that sum to about `total`, with believable variance."""
    if n == 0:
        return []
    mean = total / n
    return [max(quantise(mean * random.uniform(1 - jitter, 1 + jitter)), quantise(mean * 0.2))
            for _ in range(n)]

book_out = spread(247, len(days_worked["book"]), 0.45, lambda v: round(v))
prob_out = spread(182, len(days_worked["probs"]), 0.5, lambda v: round(v))
ch3_out = spread(20, len(days_worked["ch3"]), 0.6, lambda v: round(v * 2) / 2)

sessions = 0
for day in gym_days:
    log(t_gym["id"], day=day, expected=1, actual=1, minutes=random.randint(35, 70), hour=7)
    sessions += 1
for day, out in zip(days_worked["book"], book_out):
    log(t_book["id"], day=day, expected=10, actual=out, minutes=random.randint(22, 28), hour=9)
    sessions += 1
for day, out in zip(days_worked["probs"], prob_out):
    log(t_probs["id"], day=day, expected=3, actual=out, minutes=random.randint(20, 30), hour=18)
    sessions += 1
for day, out in zip(days_worked["ch3"], ch3_out):
    log(t_ch3["id"], day=day, expected=0.7, actual=out, minutes=random.randint(20, 30), hour=20)
    sessions += 1
for day in days_worked["refs"]:
    log(milestone_id=m_refs["id"], day=day, intent_met=True,
        minutes=random.randint(18, 26), hour=16)
    sessions += 1

# A few interrupted sessions: retained, excluded from pace (§23.6).
for offset in (3, 12, 26):
    log(t_book["id"], day=TODAY - timedelta(days=offset), expected=10, actual=3,
        minutes=9, interrupted=True, hour=11)
    sessions += 1

book_pages = sum(book_out)
ch3_pages = sum(ch3_out)
print(f"{sessions} sessions · {book_pages} pages · {sum(prob_out)} problems · {ch3_pages} draft pages")

# ------------------------------------------------------- capacity & the week
cap = call("POST", "/api/capacity", {"week_start": MONDAY.isoformat(), "available_hours": 12})
cid = cap["capacity"]["id"]
call("PUT", f"/api/capacity/{cid}/budgets", {"goal_id": g_offer["id"], "budgeted_sessions": 12})
call("PUT", f"/api/capacity/{cid}/budgets", {"goal_id": g_thesis["id"], "budgeted_sessions": 10})
call("PUT", f"/api/capacity/{cid}/budgets", {"goal_id": g_gym["id"], "budgeted_sessions": 6})

call("POST", "/api/planning/commit", [
    {"trackable_id": t_book["id"], "committed_sessions": 5, "target_units": 55},
    {"trackable_id": t_probs["id"], "committed_sessions": 6, "target_units": 20},
    {"trackable_id": t_ch3["id"], "committed_sessions": 6, "target_units": 8},
    {"trackable_id": t_gym["id"], "committed_sessions": 6, "target_units": 6},
    {"milestone_id": m_refs["id"], "committed_sessions": 2},
])

# A shaped week: mostly even, one deliberately heavy day so the catch-up cap
# warning is visible, and two sessions left in the tray.
plan = [
    (0, [(t_book["id"], 1), (t_probs["id"], 2), (t_gym["id"], 1), (t_ch3["id"], 1)]),  # heavy
    (1, [(t_book["id"], 1), (t_probs["id"], 1), (t_gym["id"], 1)]),
    (2, [(t_probs["id"], 1), (t_gym["id"], 1), (m_refs["id"], 1)]),
    (3, [(t_book["id"], 1), (t_ch3["id"], 1), (t_gym["id"], 1)]),
    (4, [(t_probs["id"], 1), (t_gym["id"], 1), (t_ch3["id"], 1)]),
    (5, [(t_book["id"], 1), (t_gym["id"], 1)]),
    (6, [(t_probs["id"], 1), (t_ch3["id"], 1)]),
]
allocations = []
for dow, items in plan:
    for target, n in items:
        key = "milestone_id" if target == m_refs["id"] else "trackable_id"
        allocations.append({
            "trackable_id": None, "milestone_id": None,
            key: target,
            "plan_date": (MONDAY + timedelta(days=dow)).isoformat(),
            "sessions": n,
        })
result = call("PUT", "/api/planning/allocations",
              {"week_start": MONDAY.isoformat(), "allocations": allocations})
print("week shaped:", [(c["label"], f"{c['placed_sessions']}/{c['committed_sessions']}")
                       for c in result["commitments"]])

call("POST", f"/api/planning/day?plan_date={TODAY.isoformat()}")

# --------------------------------------------------------------- SQL touch-ups
with psycopg.connect(DB) as c:
    # 1. Every session created through POST /api/sessions is flagged retroactive
    #    by design -- the timed path stamps started_at as "now" and so cannot
    #    produce history. Calibration reports the two distributions separately
    #    (§24.5/D13), so a demo where everything is retroactive shows only half
    #    the widget. Flip the older two thirds to timed.
    c.execute(
        "update work_session set entered_retroactively = false "
        "where user_id = %s and id in ("
        "  select id from work_session where user_id = %s order by random() "
        "  limit (select count(*) * 2 / 3 from work_session where user_id = %s))",
        (USER_ID, USER_ID, USER_ID),
    )

    # 2. The self-assessed curve (D12). It is only writable when a *timed*
    #    session ends, so a historical series cannot be created through the API
    #    at all. This is the shape §24.9 describes: climbs, then flattens --
    #    which is evidence for rescoping, not for pushing harder.
    for weeks_ago, pct in ((10, 20), (8, 45), (6, 60), (4, 70), (2, 70), (1, 70)):
        c.execute(
            "insert into progress_check (user_id, milestone_id, self_assessed_pct, recorded_at) "
            "values (%s, %s, %s, %s)",
            (USER_ID, m_refs["id"], pct,
             datetime.combine(TODAY - timedelta(weeks=weeks_ago), datetime.min.time(), UTC)),
        )
    # 3. created_at is stamped by the server, so everything seeded today claims
    #    to have started today. For finished work that collapses the timeline's
    #    planned and actual bars into a dot four days wide. Backdate the one
    #    goal whose whole purpose here is to show a completed span.
    c.execute(
        "update goal set created_at = %s, completed_at = %s where id = %s",
        (datetime.combine(TODAY - timedelta(days=44), datetime.min.time(), UTC),
         datetime.combine(TODAY - timedelta(days=6), datetime.min.time(), UTC),
         g_tax["id"]),
    )
    c.execute(
        "update milestone set created_at = %s, completed_at = %s where id = %s",
        (datetime.combine(TODAY - timedelta(days=44), datetime.min.time(), UTC),
         datetime.combine(TODAY - timedelta(days=6), datetime.min.time(), UTC),
         m_tax["id"]),
    )
    c.commit()

print(f"\nDone. Sign in as {EMAIL} / {PASSWORD}")
