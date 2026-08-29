"""allow recurring commitments to be active

Revision ID: 5f3867bf6ec7
Revises: 312843ad930e
Create Date: 2026-08-28 06:53:37.213771
"""
from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = '5f3867bf6ec7'
down_revision: str | None = '312843ad930e'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """§12 FIX: a recurring commitment has a deadline every period.

    Alembic does not autogenerate CHECK constraint changes, so this is written
    by hand. The old constraint demanded an absolute date of every active
    non-vision goal, which made "gym six days a week" impossible to activate --
    exactly the category §12 calls "recurring deadlines, not an exception".
    """
    op.drop_constraint("goal_active_requires_deadline", "goal", type_="check")
    op.create_check_constraint(
        "goal_active_requires_deadline",
        "goal",
        "kind = 'vision' "
        "OR activation <> 'active' "
        "OR deadline IS NOT NULL "
        "OR (pace_mode = 'reset_period' AND reset_period_days IS NOT NULL)",
    )


def downgrade() -> None:
    op.drop_constraint("goal_active_requires_deadline", "goal", type_="check")
    op.create_check_constraint(
        "goal_active_requires_deadline",
        "goal",
        "kind = 'vision' OR activation <> 'active' OR deadline IS NOT NULL",
    )
