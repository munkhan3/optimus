"""Add a second measurement axis: work done, alongside progress made.

`trackable.unit` measures PROGRESS and is chosen because its denominator is
knowable -- a book has 380 pages. It is a poor measure of WORK, because a page
holding an hour-long problem is not a page of prose, and every bit of that
difference currently lands in pace variance where §25.4 can mistake it for the
user being slow.

The second axis measures work. Crucially it needs no total to be useful: eight
problems in a session says something whether or not anyone knows how many
problems the book contains, and that total is precisely what is hard to
discover. `secondary_total_units` is therefore nullable and is required only to
promote this axis to primary; it is also the one field here that can hold a
model estimate, which is why it carries a provenance column.

NULL `secondary_unit` means "this trackable has no second axis". It never means
zero. NULL `secondary_output` on a session means the count was not recorded,
which is not the same as having solved nothing -- pace and the density fit both
skip such rows rather than reading them as zeros.

`baseline.unit` exists because §25.3 keeps baseline history forever and a metric
switch changes what `scope_units` counts. Without the unit recorded, v1's "380"
beside v2's "210" reads as a scope cut rather than the same work in a different
currency.

On the fifth resolution: §17 fixes exactly four ways to respond to divergence
between plan and reality, and this adds `change_metric` beside them. That is a
marked departure, not an oversight. The four are answers to "reality diverged
from the plan, what gives?"; re-expressing scope in a better unit is a different
act, and folding it into `cut_scope` would record a lie in permanent history.
FOUR_OPTIONS in optimus/metrics/rebaseline.py stays at four and `change_metric`
is unreachable from the drift flow, so what §17 actually protects -- that the
system never drifts by quietly moving the deadline -- is untouched.

Revision ID: b7e2a4c93f18
Revises: a91f2c7d40be
Create Date: 2026-08-30
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

from optimus.api.db import COMPLETED_UNITS_TRIGGER

revision: str = "b7e2a4c93f18"
down_revision: str | None = "a91f2c7d40be"
branch_labels = None
depends_on = None


# The trigger as it stood before this migration. Kept verbatim so `downgrade`
# restores the old behaviour rather than leaving a function that references a
# column which no longer exists.
_PRIOR_TRIGGER = """
CREATE OR REPLACE FUNCTION refresh_completed_units() RETURNS TRIGGER AS $$
DECLARE
    affected BIGINT;
BEGIN
    affected := COALESCE(NEW.trackable_id, OLD.trackable_id);
    IF affected IS NOT NULL THEN
        UPDATE trackable
           SET completed_units = COALESCE(
                   (SELECT SUM(actual_output)
                      FROM work_session
                     WHERE trackable_id = affected
                       AND actual_output IS NOT NULL), 0)
         WHERE id = affected;
    END IF;

    IF TG_OP = 'UPDATE'
       AND OLD.trackable_id IS DISTINCT FROM NEW.trackable_id
       AND OLD.trackable_id IS NOT NULL THEN
        UPDATE trackable
           SET completed_units = COALESCE(
                   (SELECT SUM(actual_output)
                      FROM work_session
                     WHERE trackable_id = OLD.trackable_id
                       AND actual_output IS NOT NULL), 0)
         WHERE id = OLD.trackable_id;
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;
"""


def upgrade() -> None:
    op.add_column("trackable", sa.Column("secondary_unit", sa.Text(), nullable=True))
    op.add_column(
        "trackable", sa.Column("secondary_total_units", sa.Float(), nullable=True)
    )
    op.add_column(
        "trackable", sa.Column("secondary_total_units_source", sa.Text(), nullable=True)
    )
    op.add_column(
        "trackable",
        sa.Column(
            "secondary_completed_units",
            sa.Float(),
            nullable=False,
            server_default=sa.text("0"),
        ),
    )
    op.create_check_constraint(
        "trackable_secondary_total_positive",
        "trackable",
        "secondary_total_units IS NULL OR secondary_total_units > 0",
    )
    op.create_check_constraint(
        "trackable_secondary_completed_non_negative",
        "trackable",
        "secondary_completed_units >= 0",
    )
    op.create_check_constraint(
        "trackable_secondary_units_source_valid",
        "trackable",
        "secondary_total_units_source IS NULL OR secondary_total_units_source IN "
        "('grounded', 'user_supplied', 'model_estimated')",
    )

    op.add_column(
        "work_session", sa.Column("secondary_output", sa.Float(), nullable=True)
    )
    op.add_column(
        "work_session",
        sa.Column("secondary_expected_output", sa.Float(), nullable=True),
    )
    op.create_check_constraint(
        "work_session_secondary_output_non_negative",
        "work_session",
        "secondary_output IS NULL OR secondary_output >= 0",
    )

    op.add_column("baseline", sa.Column("unit", sa.Text(), nullable=True))

    # The fifth resolution. Rewritten rather than extended because a CHECK
    # constraint has no ALTER form.
    op.drop_constraint("baseline_resolution_valid", "baseline", type_="check")
    op.create_check_constraint(
        "baseline_resolution_valid",
        "baseline",
        "resolution IS NULL OR resolution IN ('add_sessions', 'cut_scope', "
        "'move_deadline', 'declare_infeasible', 'change_metric')",
    )

    # One function owns both caches; see the note in optimus/api/db.py.
    op.execute(COMPLETED_UNITS_TRIGGER.split("CREATE TRIGGER")[0])


def downgrade() -> None:
    op.execute(_PRIOR_TRIGGER)

    op.drop_constraint("baseline_resolution_valid", "baseline", type_="check")
    op.create_check_constraint(
        "baseline_resolution_valid",
        "baseline",
        "resolution IS NULL OR resolution IN ('add_sessions', 'cut_scope', "
        "'move_deadline', 'declare_infeasible')",
    )
    op.drop_column("baseline", "unit")

    op.drop_constraint(
        "work_session_secondary_output_non_negative", "work_session", type_="check"
    )
    op.drop_column("work_session", "secondary_expected_output")
    op.drop_column("work_session", "secondary_output")

    op.drop_constraint(
        "trackable_secondary_units_source_valid", "trackable", type_="check"
    )
    op.drop_constraint(
        "trackable_secondary_completed_non_negative", "trackable", type_="check"
    )
    op.drop_constraint("trackable_secondary_total_positive", "trackable", type_="check")
    op.drop_column("trackable", "secondary_completed_units")
    op.drop_column("trackable", "secondary_total_units_source")
    op.drop_column("trackable", "secondary_total_units")
    op.drop_column("trackable", "secondary_unit")
