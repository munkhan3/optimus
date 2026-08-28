# Optimus — Design Document

**Status:** Living design document
**Audience:** The author, and Claude Code for implementation
**Structure:** Part I is the north star. Part II is the system model that follows from it.
Part III is the v0 build spec. Part IV is the path from v0 to the north star.

> **Reading note.** Parts I and II are version-independent and should change rarely. Part
> III is the current build and will churn. If Part III ever contradicts Part I, Part I wins
> and Part III is wrong.

---

---

# PART I — VISION

## 1. North star

> **Optimus is a personal operating system that continuously translates long-term intent
> into today's highest-value actions, measures whether those actions actually produced
> progress, and updates its model of how the user works so that each plan is more honest
> than the last.**

The system is not a place to store tasks. It is a standing answer to one question, asked
every morning:

> _Given everything I am trying to achieve, everything I have committed to, how fast I
> actually work, and how much time I actually have — what should I be doing right now, and
> why?_

The product succeeds when the user trusts that answer enough to act on it without
re-deriving it themselves, and when the system's account of their progress is more accurate
than their own intuition.

## 2. The problem, stated precisely

The user does not have a task-capture problem. Lists are easy to write. Three distinct
things are hard:

**2.1 Compilation.** Ambitions are stated at a level that cannot be executed. "Get a quant
trading offer" is not an action. Turning it into _"read 30 pages of the Green Book this
morning"_ requires a chain of reasoning that must be redone every time circumstances change,
and it is expensive enough that people avoid it and default to whatever is most salient.

**2.2 Allocation under scarcity.** Multiple goals compete for the same finite hours.
Recruiting, thesis, coursework, internship performance, a startup, health. Progress on any
one is a decision not to progress the others. Most systems ignore this entirely by treating
priority as a per-task label rather than a portfolio consequence.

**2.3 Honest measurement.** People are systematically wrong about how fast they work and how
much they have done. Without objective feedback, a plan that was never achievable can feel
fine for months, and the failure only becomes visible at the deadline, when nothing can be
done about it.

Optimus exists to solve all three. Solving only the first is a to-do app.

## 3. Why conventional tools fail

**They ask the user to supply the answer as input.** Every to-do app asks _"what priority is
this?"_ But priority is not a property of a task. It is a function of every other goal, its
deadline, current pace, remaining capacity, and what is already at risk. Asking the user to
label it is asking them to solve the hard problem manually and then type in the result.

**They measure activity, not progress.** Checkboxes and streaks reward motion. A day of
checked boxes and a day of real progress look identical.

**They have no model of the user.** They cannot tell you that you read 9 pages per session,
not the 20 you believe, because they never recorded either number.

**They do not know when a plan has become impossible.** A deadline slips, the task rolls to
tomorrow, and it rolls again. Nothing in the system ever says _this cannot be done in the
time remaining._

## 4. What the system does instead

Five capabilities, in dependency order. Each depends on the ones above it.

1. **Maintains a goal graph** — a structured, always-current representation of what the user
   is trying to achieve, from vision down to today's tasks, where every node has a
   verifiable definition of done.
2. **Measures objectively** — records expected vs. actual output for every unit of work, so
   progress and pace are observed rather than felt.
3. **Knows the user's real capacity and real speed** — an empirical model of how much they
   get done, which replaces their optimistic self-estimates.
4. **Detects infeasibility early** — flags when remaining work no longer fits before a
   deadline, while there is still time to add resources, cut scope, or renegotiate.
5. **Allocates attention across a portfolio** — recommends what to work on given everything
   competing, and explains why in terms of the underlying numbers.

## 5. The central loop

```
        INTENT
           │
           ▼
    ┌─── COMPILE ────────────────────────────┐   forward: intent becomes work
    │   vision → goal → milestone            │
    │   → trackable → task → session         │
    └────────────┬───────────────────────────┘
                 ▼
              EXECUTE
                 │
                 ▼
              MEASURE            expected vs. actual, every session
                 │
                 ▼
    ┌─── PROPAGATE ──────────────────────────┐   backward: work updates intent's status
    │   session output → trackable progress  │
    │   → milestone status → goal feasibility│
    │   → portfolio allocation               │
    └────────────┬───────────────────────────┘
                 ▼
              COMPARE            plan vs. reality, at a fixed cadence
                 │
                 ▼
             REBASELINE          add resources | cut scope | move date | declare infeasible
                 │
                 └──────────────► back to COMPILE
```

Forward compilation is what most planning tools attempt. **Backward propagation is the part
almost nobody builds**, and it is where the product's value concentrates: a page read this
morning should update, all the way up, whether the December goal is still achievable.

## 6. Durable design principles

These govern every version. They are not v0 decisions.

**P1 — The database is the source of truth; the model is a reasoning layer.**
State lives in a structured store. The LLM parses, interviews, explains, and proposes. It
never owns state. This makes the model swappable and the history permanent.

**P2 — Every number is either measured or explicitly labelled as an estimate.**
No fabricated metrics. If a value cannot be observed, the system either asks for it, marks
it as inferred, or does without it. A confident wrong number is worse than an absent one.

**P3 — The system explains itself in terms of its inputs.**
Every recommendation decomposes into the components that produced it. If the user cannot
interrogate a recommendation, they cannot calibrate their trust in it, and they will
eventually discard the whole system.

**P4 — The user decides; the system holds the line.**
The system recommends, warns, and refuses to pretend an impossible plan is fine. It never
unilaterally moves a deadline, cuts scope, or reallocates time. Final authority is the
user's, always.

**P5 — Measurement must be nearly free.**
Every metric is downstream of the user logging what happened. If logging costs more than
seconds, the data degrades, and every derived number becomes fiction. Logging cost is a
first-order design constraint, not a UX detail.

**P6 — Deterministic before learned.**
Explainable rules first, machine learning only once there is enough personal data to beat
them. The early system's job is partly to _generate the dataset_ that a later system learns
from.

**P7 — Objective progress is the motivational engine.**
The existing spreadsheet works because a filling progress bar makes a session feel real.
That effect is a feature to preserve, not a nicety.

## 7. Anti-goals

The system is explicitly **not**:

- A better checkbox list
- A habit tracker or streak/points gamification layer
- A team or collaboration tool
- A calendar replacement
- A generic productivity app for other people (v0 has exactly one user)
- An autonomous agent that acts without approval
- A system that optimizes time spent rather than output produced

## 8. What success looks like

Concrete, twelve months out:

- The morning question _"what should I work on?"_ is answered by the system and the answer is
  followed most days.
- The user can state their real pace on any recurring type of work from memory, because the
  system has told them repeatedly and they now believe it.
- At least one goal was rescoped or renegotiated **early**, because the system flagged
  infeasibility weeks before the deadline.
- No goal has silently drifted. Every deadline change is a recorded decision with a reason.
- The user's own estimates have measurably improved, visible as completion ratios trending
  toward 1.0.

---

---

# PART II — SYSTEM MODEL

Version-independent. Part III implements a subset of this.

## 9. The goal graph

Five levels. Each compiles into the one below.

| Level | Entity             | Character                                        | Example                                     |
| ----- | ------------------ | ------------------------------------------------ | ------------------------------------------- |
| 1     | **Vision**         | Directional, unbounded, never "complete"         | Build an exciting quantitative career       |
| 2     | **Goal**           | Terminating, deadlined, has a definition of done | Q1 quant trading offer in Chicago by Feb 1  |
| 3     | **Milestone**      | Objective intermediate outcome                   | Finish the Green Book; secure two referrals |
| 4     | **Trackable**      | Measurable body of work with units               | Green Book: 380 pages                       |
| 5     | **Task / Session** | A unit of execution                              | Read 30 pages this morning                  |

Visions do not compete for time. Goals do.

## 10. Definition of done is the root primitive

**A goal that cannot be recognized as complete cannot be planned against.** There is no
remaining work to compute, no pace, no feasibility, nothing.

Every goal and milestone therefore carries a definition of done before it can be activated.

**The requirement is verifiability, not numeracy.** Both of these are valid:

- _"Green Book finished"_ — verifiable and naturally metered
- _"MVP done: a stranger can sign up, build a goal tree, and log a session without help"_ —
  verifiable, not numeric

Forcing a number where none exists is the single most damaging thing the system can do. If
the user says "build a startup" and the system extracts _"$10k MRR"_ because a field needed
filling, then every projection downstream rests on a figure nobody believes. **The right
question is "what must be true for this to be done?", not "what's the number?"**

Where a natural counter exists, use it. Where it does not, the definition of done is a
checkable condition and progress is tracked by session budget rather than fabricated units.

## 11. Time as a portfolio

Time is the scarce resource, and goals are claims on it.

**Capacity** is declared, not inferred: how many focus sessions per week actually exist,
after coursework, work, sleep, and life. Capacity is divided into **budgets** per goal.

This makes the portfolio explicit. Every budget increase is visibly taken from somewhere
else. There is no free reallocation, and the system should never present one.

**On cross-goal comparison.** The tempting move is to shift time from an ahead-of-pace goal
to a behind-pace one. This does not follow. _Pace ratio measures the quality of the original
estimate, not the value of the work._ A goal at 0.7 may simply have had an aggressive plan.

What _is_ comparable across incommensurable goals is **feasibility**: does the remaining
work still fit before its deadline. That question has the same meaning in every domain.

- Taxes at 0.7 pace, due in ten days → real problem, reallocate
- Prototype at 0.7 pace, due in six months → not a problem, revise the estimate

So reallocation is triggered by projected deadline misses, not by pace comparison. Anything
short of that is surfaced as variance and left to the user.

## 12. Deadlines and activity

**Every active goal has a deadline.** A goal with no deadline is not being worked on; it is
an intention. Such goals are **parked**: stored, visible, excluded from scoring, capacity,
and pace. They compete for nothing.

**Ongoing commitments are recurring deadlines, not an exception.** "Gym six days a week" has
a deadline every week. This yields two pace modes:

- **Carry-forward** — terminating goals. A shortfall adds to remaining work. Missing 40
  pages means 40 more pages later.
- **Reset-period** — recurring commitments. The window closes and the shortfall is
  **discarded**. Missing two gym sessions does not create a debt of eight.

The distinction matters because carrying shortfall on recurring commitments produces
impossible plans and guilt, and discarding it on terminating goals hides real slippage.

## 13. Measurement and calibration

Every session records what was expected and what happened. This produces two things:

**Progress** — objective, cumulative, the motivational engine (P7).

**Calibration** — `actual / expected`, tracked over time. This is the system's model of the
user. Believing you read 20 pages per session when you read 9 is the root cause of most
plan failure, and it is invisible without this data.

Calibration data flows back into planning: expected output for a future session is prefilled
from empirical pace, not from optimism. The transition is **subjective expectation →
empirical expectation**, and it is the main thing the system knows that the user does not.

## 14. Backward propagation

The direction that makes this more than a planner. One session's output must update the
entire chain:

```
30 pages read
  → Green Book progress 63% → 71%
    → empirical pace updates (9.4 → 9.8 pages/session)
      → projected completion moves Oct 22 → Oct 19
        → milestone "finish Green Book" back inside its deadline
          → goal "Q1 offer" feasibility margin improves
            → next week's budget can shift toward the neglected goal
```

Every level's status is derived from the level below, continuously. Nothing is manually
marked "on track."

## 15. The assistant model

The right mental model for the LLM layer is **a competent personal assistant on their first
week**, not a form or a chatbot.

**15.1 Intake.** The user brain-dumps everything: goals, horizons, deadlines, constraints,
commitments, half-formed intentions. Unstructured, in one pass.

**15.2 Gap-filling interview.** The assistant identifies what it cannot responsibly infer and
asks. It does **not** fill gaps with plausible-sounding values. Anything inferred is
tagged as such and resurfaced later.

**15.3 Questions are budgeted by consequence.** A good assistant does not interrogate you
about everything equally; they ask where being wrong is expensive. Rank candidate questions
by **stakes × uncertainty**:

| Stakes | Specification | Behavior                                                 |
| ------ | ------------- | -------------------------------------------------------- |
| High   | Clear         | Ask nothing. _"Read Green Book by Dec 1"_ is complete.   |
| High   | Vague         | Interview hard. This is where wrong guesses cost months. |
| Low    | Vague         | One question, or accept the vagueness and park it.       |
| Low    | Clear         | Ask nothing.                                             |

Being wrong about reading pace costs a week and self-corrects. Being wrong about what
"demo-ready" means costs a month.

**15.4 Ongoing.** The relationship continues through review cadence. Weekly and monthly
reviews are where inferred values get corrected, scope gets renegotiated, and the assistant
reports what it has learned about how the user actually works.

## 16. Planning cadence

| Horizon     | Purpose                                    | Output                           |
| ----------- | ------------------------------------------ | -------------------------------- |
| **Yearly**  | Rebaseline goals against vision            | Active goal set                  |
| **Monthly** | Which goals advance; which milestones land | Monthly milestone targets        |
| **Weekly**  | Review, rank, and **commit**               | Committed sessions per trackable |
| **Daily**   | Redistribute the committed week            | Today's plan, with reasons       |

**The weekly commitment is the load-bearing unit.** Ranking happens weekly. The daily plan
does not re-rank — it redistributes what remains of the week across the days that remain,
adjusted for yesterday's shortfall.

This is deliberate. Re-scoring daily produces thrash: logging a session drops that item's
deficit, something else jumps to the top, the plan feels arbitrary, and the user stops
trusting it. Stability is worth more than daily optimality.

## 17. Rebaselining and the refusal to drift

When reality diverges from the plan, the system forces an explicit choice among exactly
four options:

1. **Add sessions** — from another goal's budget. Show what it costs.
2. **Cut scope** — reduce the work or weaken the definition of done. Record what was
   dropped.
3. **Move the deadline** — permitted only while the work still fits after the move.
4. **Declare infeasible** — nothing fits. Abandon, park, or escalate.

**The system must never default to option 3.** Silent deadline extension is how a goal
drifts for months without ever formally failing, and preventing it is a core purpose.

**Soft horizon.** Lower-priority work may be deferred under deadline pressure, but the
allowance is **derived, not declared**: deferral is permitted only while remaining work
still fits in the sessions available before the hard deadline. Past that point the system
stops offering later dates.

**Baseline history is permanent.** Every rebaseline is versioned with a reason, and version 1
stays on screen. Three rebaselines in, the user must be able to see that this began as ten
sessions targeting October.

## 18. Trust and control

The user must be able to interrogate any recommendation and get an answer in terms of
inputs:

> _Green Book — projected to finish 9 days past target at current pace (7.2 vs 11.4
> pages/session required). Feasible, but the margin is gone._

The primary reason is generated from stored components, never from a language model. The
model elaborates conversationally on top of it.

The user may accept, modify, reject, or defer anything. Those responses are recorded,
because revealed preference is the only real signal about the user's utility function, and
it is what a later learning layer trains on.

---

---

# PART III — v0 IMPLEMENTATION SPEC

**Scope:** single user, local-first. Anything not listed in §19 is out of scope for this
build. Part II describes the destination; this describes the first honest slice of it.

## 19. Scope

### In

1. Goal hierarchy with mandatory definition of done
2. Brain-dump ingestion plus gap-filling interview
3. Carry-forward and reset-period pace modes; parked goals
4. Declared capacity and committed session budgets
5. Work session timer with checkoff-style logging
6. Metrics: progress, empirical pace, drift, feasibility, calibration, stall
7. Weekly commitment and rebaseline flow with baseline history
8. Daily plan by redistribution, tiered, with per-item explanation
9. Progress dashboard
10. Read-only assistant over structured state

### Out

- Multi-user, sharing, real auth (single-user token suffices)
- Machine learning beyond the shrinkage estimator in §24.3
- Multi-year roadmapping
- External integrations (calendar, email, drive)
- Native mobile apps
- Agent write actions
- Gamification
- Cross-goal utility optimization (§11)
- Dependency solving beyond simple `blocked_by` flags

## 20. v0 design decisions

Concrete resolutions of Part II, binding on the implementation.

**D1 — Definition of done is mandatory and verifiable, not necessarily numeric.** A goal
cannot be activated without one. Never force a number where none exists (§10).

**D2 — The system quantifies at planning time; the user only reports completion.**
Decomposition into countable units happens during ingestion and review. Logging is a
checkoff, never an act of measurement. The user is never asked _"how much did you get
done?"_ in open form.

**D3 — The model interviews rather than guesses.** Every inferred value is tagged
`grounded` / `user_supplied` / `model_estimated`. Model-estimated values are flagged in the
UI and resurface at review. Questions are ranked by stakes × uncertainty and the interview
stops when marginal priority drops below threshold (§15.3).

**D4 — Active goals require deadlines; goals without one are parked.** Two pace modes,
carry-forward and reset-period (§12).

**D5 — Capacity is committed at planning time, breaking the pace circularity.** The naive
`remaining_units / remaining_available_sessions` is circular, because available sessions
depend on the allocation decision the pace number informs. Committing a session budget
weekly fixes the denominator. Track **progress** and **drift** separately; drift is consumed
at rebaseline, not acted on daily.

**D6 — Reallocation is triggered by feasibility, not pace ratio** (§11).

**D7 — Deferral bounded by derived feasibility, not a fixed allowance** (§17).

**D8 — Uncertainty is displayed, not propagated.** One point estimate drives all machinery.
A displayed interval gates exactly one decision: whether to rebaseline. Wide interval → a
bad week is noise. Tight interval → the slip is signal.

**D9 — Weekly commitments are sticky; days redistribute without re-ranking** (§16).
Catch-up is capped: shortfall spreads across remaining days, never dumps on tomorrow. If the
cap binds, the week does not fit — that is a rebaseline signal, not a heroic day.

**D10 — Database is source of truth; the LLM never writes directly** (P1).

**D11 — The user always decides** (P4).

**D12 — Self-assessed progress is a review signal, never a computed input.** Exploratory
milestones expose a percent-complete slider, because the user wants visible progress on work
with no honest counter. It is **never** read by the metrics or planning engine — not for
projection, pace, feasibility, scoring, or calibration. Store the full history: self-assessed
progress characteristically climbs to ~80% then stalls for weeks, and that stall is better
evidence for rescoping than any invented pace. Its only downstream use is stall detection
(§24.9).

**D13 — Retroactive sessions are down-weighted in calibration.** A timed session holds a
measured number; a reconstructed one holds a remembered number, often anchored to the
prediction. Weight `0.5` in calibration only; full weight for progress and pace. The 0.5 is
a placeholder in config — once data exists, compare completion-ratio distributions of timed
vs. retroactive sessions and set it empirically.

## 21. Data model

SQLite for v0, Postgres-compatible. Timestamps UTC, ISO 8601.

```sql
CREATE TABLE goal (
    id                  INTEGER PRIMARY KEY,
    parent_id           INTEGER REFERENCES goal(id),
    title               TEXT NOT NULL,
    description         TEXT,
    kind                TEXT NOT NULL,      -- 'vision' | 'goal'

    definition_of_done  TEXT NOT NULL,                          -- D1
    dod_source          TEXT NOT NULL,      -- 'user_supplied' | 'model_estimated'

    activation          TEXT NOT NULL,      -- 'active' | 'parked'                D4
    deadline            DATE,               -- required when active
    pace_mode           TEXT NOT NULL,      -- 'carry_forward' | 'reset_period'
    reset_period_days   INTEGER,

    stakes              INTEGER NOT NULL,   -- 1..5. Drives ranking AND interview priority.
    status              TEXT NOT NULL,      -- 'not_started'|'in_progress'|'done'|'abandoned'
    verified            BOOLEAN NOT NULL DEFAULT 0,
    created_at          TIMESTAMP NOT NULL,

    -- A vision is directional and unbounded (§9), so the deadline rule
    -- exempts it; without this an active vision is impossible to create.
    CHECK (kind = 'vision' OR activation <> 'active' OR deadline IS NOT NULL),
    CHECK (pace_mode <> 'reset_period' OR reset_period_days IS NOT NULL)
);

CREATE TABLE milestone (
    id                  INTEGER PRIMARY KEY,
    goal_id             INTEGER NOT NULL REFERENCES goal(id),
    title               TEXT NOT NULL,
    definition_of_done  TEXT NOT NULL,
    dod_source          TEXT NOT NULL,
    deadline            DATE,
    blocked_by          INTEGER REFERENCES milestone(id),
    status              TEXT NOT NULL,
    verified            BOOLEAN NOT NULL DEFAULT 0,
    created_at          TIMESTAMP NOT NULL
);

-- Metered work. A milestone whose DoD has no natural counter has no trackable and is
-- scored on feasibility + stakes alone (§25.1).
CREATE TABLE trackable (
    id                  INTEGER PRIMARY KEY,
    milestone_id        INTEGER NOT NULL REFERENCES milestone(id),
    title               TEXT NOT NULL,
    unit                TEXT NOT NULL,
    total_units         REAL NOT NULL,
    total_units_source  TEXT NOT NULL,      -- 'grounded'|'user_supplied'|'model_estimated'  D3
    completed_units     REAL NOT NULL DEFAULT 0,   -- cache of SUM(actual_output)
    target_date         DATE,
    prior_pace          REAL,               -- user's initial estimate, units/session
    task_type           TEXT NOT NULL,      -- pooling key: 'reading'|'problems'|'writing'|'exploratory'|'admin'
    exploratory         BOOLEAN NOT NULL DEFAULT 0,                -- D2/D12
    status              TEXT NOT NULL,
    created_at          TIMESTAMP NOT NULL
);

CREATE TABLE task (
    id                  INTEGER PRIMARY KEY,
    milestone_id        INTEGER REFERENCES milestone(id),
    trackable_id        INTEGER REFERENCES trackable(id),
    description         TEXT NOT NULL,
    est_minutes         INTEGER,
    expected_output     REAL,               -- prefilled from pace_hat, never a fixed guess
    intent              TEXT,               -- exploratory: what "done" means this session
    deadline            DATE,
    blocked_by          INTEGER REFERENCES task(id),
    status              TEXT NOT NULL,      -- 'open'|'done'|'deferred'|'dropped'
    created_at          TIMESTAMP NOT NULL
);

CREATE TABLE capacity (                                            -- D5
    id                  INTEGER PRIMARY KEY,
    week_start          DATE NOT NULL UNIQUE,
    available_hours     REAL NOT NULL,
    session_minutes     INTEGER NOT NULL DEFAULT 25
);

CREATE TABLE goal_budget (
    id                  INTEGER PRIMARY KEY,
    capacity_id         INTEGER NOT NULL REFERENCES capacity(id),
    goal_id             INTEGER NOT NULL REFERENCES goal(id),
    budgeted_sessions   INTEGER NOT NULL,
    UNIQUE (capacity_id, goal_id)
);

CREATE TABLE weekly_commitment (                                   -- D9
    id                  INTEGER PRIMARY KEY,
    capacity_id         INTEGER NOT NULL REFERENCES capacity(id),
    trackable_id        INTEGER REFERENCES trackable(id),
    milestone_id        INTEGER REFERENCES milestone(id),
    committed_sessions  INTEGER NOT NULL,
    target_units        REAL,
    -- D9 requires the weekly score to be computed once and reused by every day
    -- of that week. plan_item is rewritten daily, so the frozen value lives here
    -- and is copied onto each day's plan_item unchanged.
    score               REAL,
    score_breakdown     TEXT,               -- JSON
    committed_at        TIMESTAMP NOT NULL
);

CREATE TABLE work_session (                                        -- D2, P5
    id                  INTEGER PRIMARY KEY,
    task_id             INTEGER REFERENCES task(id),
    trackable_id        INTEGER REFERENCES trackable(id),
    milestone_id        INTEGER REFERENCES milestone(id),
    -- Denormalized: §24.3 pools pace by task_type, and reaching it through the
    -- trackable breaks for milestone-only sessions and silently rewrites history
    -- if a trackable is later reclassified.
    task_type           TEXT NOT NULL,
    started_at          TIMESTAMPTZ NOT NULL,
    ended_at            TIMESTAMP,
    planned_minutes     INTEGER NOT NULL,
    actual_minutes      REAL,
    expected_output     REAL,
    actual_output       REAL,
    intent_met          BOOLEAN,            -- exploratory sessions, instead of a count
    focus_rating        INTEGER,
    note                TEXT,
    interrupted         BOOLEAN NOT NULL DEFAULT 0,   -- excluded from pace, retained
    entered_retroactively BOOLEAN NOT NULL DEFAULT 0  -- D13
);

CREATE TABLE progress_check (                                      -- D12
    id                  INTEGER PRIMARY KEY,
    milestone_id        INTEGER REFERENCES milestone(id),
    trackable_id        INTEGER REFERENCES trackable(id),
    self_assessed_pct   REAL NOT NULL,      -- 0..100
    session_id          INTEGER REFERENCES work_session(id),
    note                TEXT,
    recorded_at         TIMESTAMP NOT NULL
);

CREATE TABLE baseline (                                            -- §17
    id                  INTEGER PRIMARY KEY,
    trackable_id        INTEGER REFERENCES trackable(id),
    milestone_id        INTEGER REFERENCES milestone(id),
    version             INTEGER NOT NULL,   -- 1 = original, retained forever
    planned_sessions    INTEGER NOT NULL,
    scope_units         REAL,
    target_date         DATE NOT NULL,
    resolution          TEXT,               -- 'add_sessions'|'cut_scope'|'move_deadline'
    rationale           TEXT,
    created_at          TIMESTAMP NOT NULL,
    -- A baseline attaches to exactly one of the two, and BOTH sides need
    -- uniqueness; constraining only the trackable side let a milestone acquire
    -- two version-1 rows.
    CHECK ((trackable_id IS NOT NULL) <> (milestone_id IS NOT NULL)),
    UNIQUE (trackable_id, version),
    UNIQUE (milestone_id, version)
);

CREATE TABLE open_gap (                                            -- D3
    id                  INTEGER PRIMARY KEY,
    goal_id             INTEGER REFERENCES goal(id),
    milestone_id        INTEGER REFERENCES milestone(id),
    -- total_units lives on trackable, and acceptance test 18 requires a gap
    -- whenever one is model_estimated. Without this the test cannot be met.
    trackable_id        INTEGER REFERENCES trackable(id),
    question            TEXT NOT NULL,
    priority            REAL NOT NULL,      -- stakes × uncertainty
    status              TEXT NOT NULL,      -- 'open'|'answered'|'dismissed'
    answer              TEXT,
    created_at          TIMESTAMP NOT NULL
);

CREATE TABLE daily_plan (
    id                  INTEGER PRIMARY KEY,
    plan_date           DATE NOT NULL UNIQUE,
    generated_at        TIMESTAMP NOT NULL,
    capacity_minutes    INTEGER NOT NULL,
    carried_shortfall   REAL,               -- spread, never dumped     D9
    accepted_at         TIMESTAMP
);

CREATE TABLE plan_item (
    id                  INTEGER PRIMARY KEY,
    daily_plan_id       INTEGER NOT NULL REFERENCES daily_plan(id),
    task_id             INTEGER REFERENCES task(id),
    trackable_id        INTEGER REFERENCES trackable(id),
    tier                TEXT NOT NULL,      -- 'A'|'B'|'C'|'D'
    score               REAL NOT NULL,      -- from weekly ranking; NOT recomputed daily
    score_breakdown     TEXT NOT NULL,      -- JSON, every component. Required.  P3
    allocated_units     REAL,
    rank                INTEGER NOT NULL,
    user_action         TEXT,               -- 'accepted'|'modified'|'rejected'|'deferred'
    completed           BOOLEAN NOT NULL DEFAULT 0
);
```

**On `score_breakdown`:** not telemetry. It is the only way to answer _"why this?"_ (P3) and
it is the training set for Part IV's learning layer. Persist every component, always.

**On `completed_units`:** a cache. Authoritative value is `SUM(actual_output)`. Recompute on
write; never let them diverge.

## 22. Ingestion and interview

Three stages.

**22.1 Parse.** Brain dump in. Extract candidate goals, horizons, deadlines, constraints,
commitments. Every inferred value tagged by provenance.

**22.2 Identify and rank gaps.** For each candidate:

1. Is there a verifiable definition of done? If not → always a gap.
2. Is `total_units` `model_estimated`? → gap.
3. Is there a deadline, or should this be parked?
4. Is `pace_mode` determinable?

Score each `priority = stakes × uncertainty`, write to `open_gap`, ask in priority order,
**stop when marginal priority falls below threshold.** Do not walk the full list.

**22.3 Interview and propose.** Rules:

- Ask for verifiable conditions, not numbers, when no natural counter exists. For an MVP:
  _"What must someone be able to do in it, and who has to have used it?"_ Never _"what
  MRR?"_ unless the user is genuinely forecasting revenue.
- Never fabricate a value to move on. Leave the gap open and flag it.
- Mark open-ended work `exploratory = 1` rather than assigning invented units.

Output is a **proposal object**, not persisted state. The user edits and approves.
Unanswered gaps persist and resurface at weekly review.

## 23. Session logging

In priority order. If any of these takes more than one interaction, the implementation is
wrong (P5).

1. Starting from the daily plan is one tap; task, trackable, duration, and expected output
   prefilled.
2. Ending a metered session takes **one input**: actual output, prefilled with the expected
   value so confirming is one tap.
3. Ending an exploratory session takes **one toggle**: intent met. The progress slider (D12)
   is offered alongside, prefilled at last value, always skippable — skipping must be the
   path of least resistance, since a forced slider produces invented numbers.
4. Expected output always comes from `pace_hat`, never a fixed guess.
5. Retroactive entry must exist and set `entered_retroactively`. Absent it, every forgotten
   day becomes a permanent hole.
6. `interrupted` is one toggle; excluded from pace, retained.

## 24. Metrics engine

Pure: reads state, returns numbers, no side effects.

**24.1 Percent complete** — `completed_units / total_units`

**24.2 Required pace** (denominator fixed by commitment, D5)

```
remaining_units    = total_units - completed_units
remaining_sessions = committed_sessions - sessions_used_this_week
required_pace      = remaining_units / max(remaining_sessions, 1)
```

For `reset_period` goals, remaining units reset each period; shortfall is discarded (D4).

**24.3 Empirical pace** (shrinkage, D8) — pooled by `task_type`, non-interrupted sessions.

```
pace_hat = (kappa * prior_pace + n * observed_mean) / (kappa + n)      kappa = 5
```

`pace_hat` drives all machinery. **Displayed interval:** IQR once `n >= 5`; before that a
fixed wide band labelled provisional. The interval drives nothing except §25.4.

**24.4 Drift** (consumed at rebaseline)

```
drift = (remaining_units / pace_hat) - planned_sessions_remaining
```

Report against version-1 baseline too, so cumulative slip is visible.

**24.5 Calibration** — `actual_output / expected_output`, rolling median per task type.
Retroactive sessions weighted at `retroactive_calibration_weight` (default 0.5, D13); full
weight in 24.1 and 24.3. Expose timed and retroactive distributions separately so the weight
can later be set empirically.

**24.6 Feasibility**

```
feasible = (remaining_units / pace_hat) <= sessions_available_before_deadline
```

If false → **infeasible** state. Never report infinite required pace; never silently propose
a later date.

**24.7 Projected completion** — displayed as a range from the pace interval, never a single
date.

**24.8 Goal health** — composite, components always shown:

```
feasibility margin (dominant) | drift | days to nearest deadline | days since last session
```

Pace ratio is deliberately not dominant (D6). Self-assessed progress is **not a term** — a
milestone the user sliders to 80% is not thereby healthy.

**24.9 Stall detection** (exploratory only, D12)

```
sessions_since_movement = sessions logged since last progress_check with |Δpct| >= 5
stalled = sessions_since_movement >= stall_threshold_sessions (default 4)
          AND latest pct < 100
```

Produces a **review prompt, not a score change**, routed into §25.2. Report the raw series:
40 → 60 → 75 → 80 → 80 → 80 tells a story a single number does not. A long stall usually
means the remaining work was underestimated, so the likely resolution is cutting scope or
sharpening the definition of done.

## 25. Planning

**25.1 Weekly ranking** (weekly only, D9)

```
score = w_f * feasibility_pressure    -- how close to infeasible; 0 if comfortable
      + w_u * urgency                 -- normalized inverse days-to-deadline
      + w_s * stakes                  -- parent goal stakes, normalized
      + w_b * unblocking              -- 1 if something is blocked_by this
      + w_n * neglect                 -- days since last session on this goal, capped
      - w_e * effort_penalty          -- est_minutes normalized
```

Defaults `w_f=0.30, w_u=0.20, w_s=0.20, w_b=0.10, w_n=0.10, w_e=0.10`. In config.

**Pace deficit is deliberately absent** (D6). Feasibility pressure replaces it. This also
removes the structural bias against milestones with no natural counter: they are scored on
identical terms rather than needing a correction factor.

**25.2 Rebaseline.** Triggers: metered work with material drift and a tight interval
(§25.4); exploratory work flagged stalled (§24.9). Presents the four-option choice from §17.
Must not default to moving the deadline.

**25.3 Baseline history.** Every rebaseline writes a versioned row with rationale. Version 1
displayed alongside current, always.

**25.4 Rebaseline gate** (D8). Do not rebaseline while the pace interval is wide. A bad week
at `n = 2` is noise. Require `n >= 5`, or drift exceeding the interval's upper bound.

**25.5 Daily redistribution** (D9) — arithmetic, no scoring.

```
per_day = (committed_units - completed_this_week) / working_days_remaining
```

Cap at `1.25 × baseline_daily_allocation`. If the cap binds, the week does not fit — surface
for rebaseline rather than issuing a day the user will not complete.

Tiers, presentation only, derived from weekly score plus deadline flags:
**A** deadline risk · **B** above threshold, no risk · **C** under 15 minutes · **D** rest,
collapsed.

**25.6 Explanation** — one line per item generated from `score_breakdown`, never from the
LLM. The model elaborates on top; it never produces the primary reason (P3).

## 26. LLM integration

**Ingestion** per §22. Strict JSON, no preamble, parsed defensively with re-prompt on
malformed output.

**Read-only assistant**, constrained tools over the metrics engine:

| Tool                                 | Returns                                         |
| ------------------------------------ | ----------------------------------------------- |
| `get_goal_state(goal_id?)`           | hierarchy with current metrics                  |
| `get_pace(trackable_id)`             | pace_hat, interval, required, drift, projection |
| `get_feasibility(goal_id)`           | margin, sessions available, infeasible flag     |
| `get_plan(date)`                     | plan items with score breakdowns                |
| `get_sessions(range, filters)`       | session history                                 |
| `get_budget_status(week)`            | committed vs consumed per goal                  |
| `get_baselines(trackable_id)`        | full rebaseline history                         |
| `get_progress_history(milestone_id)` | slider series plus stall flag                   |
| `get_open_gaps()`                    | unanswered interview questions                  |

No write tools in v0. Model: `claude-sonnet-5`.

## 27. Stack

- **Backend:** Python, FastAPI, SQLModel over SQLite
- **Metrics engine:** pure Python module, no framework dependencies, unit-tested standalone
- **Frontend:** React + Vite + Tailwind, responsive so the phone works via browser
- **Deployment:** local for v0; Tailscale or small Fly.io instance when phone access matters,
  swapping SQLite for Postgres then
- **Config:** every hand-set constant in this document — planning weights, `kappa`, tier
  thresholds, catch-up cap, `retroactive_calibration_weight`, `stall_threshold_sessions` —
  lives in one TOML file. Several are placeholders meant to be replaced by measured values.

## 28. Build order

Four milestones, each independently usable. **Do not start the next until the previous has
been used for real for several days.**

**M1 — Log and measure.** `trackable`, `work_session`, `baseline`. Manual trackable creation,
no goal tree or ingestion yet. Timer plus retroactive entry. Metrics 24.1–24.5. One screen:
trackables with progress, pace, interval, drift, projection.

_This replicates the existing spreadsheet and adds calibration. If it is not used daily,
stop and diagnose before building anything else._ Everything downstream is worthless without
the logging habit.

**M2 — Hierarchy, definitions of done, capacity.** Full schema. Goal tree CRUD with mandatory
DoD. Ingestion and gap-filling interview. Capacity, budgets, activation/parking. Feasibility,
goal health, exploratory flag, slider, stall detection.

**M3 — Planning and rebaselining.** Weekly ranking. Rebaseline flow with four-option choice
and baseline history. Daily redistribution with capped catch-up. Accept/modify/reject/defer
capture.

**M4 — Assistant and review.** Read-only tools. Embedded chat over structured state. Weekly
and monthly review views, plan-vs-actual.

## 29. Acceptance tests

1. A goal cannot be activated without a definition of done and a deadline.
2. Zero-session trackables report a provisional pace, labelled.
3. A missed `reset_period` window starts the next period at zero, no accumulated debt.
4. A missed `carry_forward` target adds the shortfall to remaining work.
5. Work exceeding available sessions before the deadline yields **infeasible** — not an
   absurd required pace, not an auto-extended deadline.
6. A milestone with no trackable and a near deadline can outrank an on-pace metered
   trackable.
7. `completed_units` always equals `SUM(actual_output)`.
8. Interrupted sessions do not affect `pace_hat`.
9. With `n = 2` and a wide interval, a bad week does **not** trigger a rebaseline proposal.
10. Two consecutive unchanged days produce plans whose top three overlap by at least two.
11. A two-day shortfall spreads across remaining days and never exceeds the 1.25× cap.
12. Every rebaseline retains version 1 and displays it alongside current.
13. Every plan item has a non-empty `score_breakdown`.
14. `self_assessed_pct` appears in no projection, pace, feasibility, health, or score
    computation. Setting a slider to 100 changes no derived number anywhere.
15. A milestone whose slider has not moved 5 points across 4 sessions is flagged stalled.
16. Skipping the slider takes one tap and writes no `progress_check` row.
17. A retroactive session contributes fully to `completed_units` and `pace_hat`, and at the
    configured weight to calibration.
18. The ingestion pipeline never writes a `model_estimated` `total_units` without also
    creating an `open_gap` row.

---

---

# PART IV — ROADMAP TO THE NORTH STAR

Each stage is gated on **data that must exist first**, not on time. Building a stage before
its data exists produces a system that guesses confidently, which is the failure mode P2
exists to prevent.

## 30. v0 — Honest measurement _(Part III)_

**Delivers:** the goal graph, objective progress, empirical pace, feasibility, explainable
weekly planning.

**Generates:** the founding dataset — sessions, expected vs. actual, plan items with score
breakdowns, accept/reject decisions, rebaseline history.

**Proves:** that the loop is worth automating at all. If the logging habit does not hold,
nothing later matters, and that is worth learning in week two rather than month six.

## 31. v1 — Personalized calibration

**Gated on:** ~50 sessions per task type.

- Replace pooled shrinkage with a hierarchical model: partial pooling across task types, so
  a new trackable inherits from similar work rather than starting at the user's optimism.
- Pace conditioned on context — time of day, session length, day of week — where the data
  supports it.
- Estimate reliability per task type: _"your reading estimates are well calibrated; your
  coding estimates run 40% optimistic."_
- Automatic deflation of user-supplied estimates by their historical bias.

**Unlocks:** plans that are achievable by construction rather than by hope.

## 32. v2 — Learned allocation

**Gated on:** several months of accept/reject decisions and outcomes.

This is where §11's deferred question gets answered. v0 refuses to optimize across goals
because it has no utility function. By v2 there is a revealed-preference dataset:

- Which recommendations were accepted, and which were quietly ignored
- Which allocations preceded real progress vs. wasted time
- Which goals the user systematically over- or under-invests in relative to stated stakes

**Delivers:** budget _proposals_ rather than purely user-set budgets, with the reasoning
shown. Detection of stated-vs-revealed priority mismatch — _"you rank the startup 4 but give
it 8% of your sessions."_ Prediction of which tasks get deferred, so the plan stops
scheduling work that never happens.

**Still requires approval for everything** (P4).

## 33. v3 — Long-horizon planning

**Gated on:** at least one full goal completed end-to-end with clean history.

- Multi-year roadmapping with dependency sequencing
- Scenario comparison: _"if I add 5 sessions/week to recruiting through December, what
  happens to the thesis?"_
- Retrospective analysis across completed goals: which milestone structures actually
  predicted success

## 34. v4 — Controlled write actions

**Gated on:** demonstrated trust — the user following recommendations consistently.

The assistant gains bounded write access: create tasks, defer, adjust budgets within limits,
propose rebaselines. Every write remains reversible and logged. Deadline changes and scope
cuts stay manual, permanently — those are the decisions the system exists to keep honest.

## 35. What never changes

Across every version: the database is the source of truth, every number is measured or
labelled, every recommendation is interrogable, the user has final authority, and the system
refuses to pretend an impossible plan is fine.

---

## 36. Open questions

1. **Session length.** Fixed 25 minutes, or per-task-type? Fixed keeps pace pooling clean;
   variable is more realistic for reading vs. problem sets.
2. **Budget setting.** Weekly budgets are user-declared, which reintroduces some of the
   manual prioritization the product exists to remove. Acceptable for v0; §32 is the real
   answer.
3. **Gap after absence.** If nothing is logged for a week, does the system rebaseline
   automatically, flag infeasibility, or stay silent? Undefined, and it is the most likely
   real-world scenario. Leaning toward: compute nothing new, present the drift on return,
   route into rebaseline.
4. **Stall threshold.** 4 sessions with under 5 points of movement is a guess. It may fire on
   genuinely hard debugging stretches where several fruitless sessions are normal. Watch the
   false-positive rate before trusting it as a trigger.
5. **Slider anchoring.** Prefilling at last value makes skipping cheap but probably suppresses
   downward revisions — nobody drags a progress bar backwards. A downward move is the most
   informative signal the slider can produce, and the current design makes it the hardest to
   produce.
6. **The system as a competing goal.** Building this consumes the same scarce hours it is
   meant to allocate, and it competes directly with recruiting. It should be entered into the
   portfolio as a goal with a deadline and a definition of done, subject to its own
   feasibility checks. If it cannot survive its own logic, that is worth knowing early.
