"""Record time worked past the planned end of a session.

A session has always had a planned length and a measured one, and the gap
between them was thrown away as noise. It is not noise: a timer that runs out
and gets ignored is the clearest signal the log carries about which work the
user actually wants to be doing. Storing it separately rather than recomputing
actual - planned keeps the two apart, because they are not the same claim --
the derived figure counts a session someone walked away from, and the recorded
one counts a crossing the client watched happen.

NULL means unknown, and specifically means "ended before this column existed".
It must never be rendered as zero minutes of flow.

Revision ID: a91f2c7d40be
Revises: c3d5f8a91b64
Create Date: 2026-08-29
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "a91f2c7d40be"
down_revision: str | None = "c3d5f8a91b64"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "work_session",
        sa.Column("flow_minutes", sa.Float(), nullable=True),
    )
    # Flow can only be non-negative: it is time past a boundary, and a session
    # that stopped early did not cross one. Enforced in the database because
    # every derived total assumes it.
    op.create_check_constraint(
        "work_session_flow_minutes_non_negative",
        "work_session",
        "flow_minutes IS NULL OR flow_minutes >= 0",
    )


def downgrade() -> None:
    op.drop_constraint("work_session_flow_minutes_non_negative", "work_session")
    op.drop_column("work_session", "flow_minutes")
