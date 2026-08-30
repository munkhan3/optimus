"""Add dashboards, manual week allocations, and completion timestamps.

Three additions, each in service of showing the user what is actually happening
rather than only what is currently true.

  dashboard_layout    The arrangement of widgets, one JSON document per user.
                      A row per widget was the obvious shape and the wrong one:
                      a single drag rewrites every position at once, so N-row
                      churn per gesture buys nothing a document does not.

  session_allocation  The week shaped by hand (§25.5 is arithmetic; this is the
                      user overriding it, D11). It is a table of its own rather
                      than a flag on plan_item because plan items are
                      disposable -- POST /api/planning/day deletes and rewrites
                      them -- and a user decision must outlive any number of
                      regenerations.

  completed_at        goal/milestone/trackable record status but never when it
                      changed, so "what did I finish, and when" was unanswerable
                      and a planned-vs-actual roadmap could not be drawn.
                      Existing rows stay NULL, which means UNKNOWN and must
                      never be rendered as "not finished".

Revision ID: c3d5f8a91b64
Revises: 9c1e4b7a2d05
Create Date: 2026-08-29
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "c3d5f8a91b64"
down_revision: str | None = "9c1e4b7a2d05"
branch_labels = None
depends_on = None


OWNER_DEFAULT = sa.text("NULLIF(current_setting('app.user_id', true), '')::integer")

TENANT_TABLES = ("dashboard_layout", "session_allocation")


def _enable_rls(table: str) -> None:
    """The loader filter in db.py is defence in depth. This is the boundary."""
    op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
    op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")
    op.execute(
        f"CREATE POLICY {table}_account_isolation ON {table} "
        "USING (NULLIF(current_setting('app.user_id', true), '') IS NULL "
        "OR user_id = NULLIF(current_setting('app.user_id', true), '')::integer) "
        "WITH CHECK (NULLIF(current_setting('app.user_id', true), '') IS NULL "
        "OR user_id = NULLIF(current_setting('app.user_id', true), '')::integer)"
    )


def _owner_column() -> sa.Column:
    return sa.Column(
        "user_id",
        sa.Integer(),
        sa.ForeignKey("app_user.id", ondelete="CASCADE"),
        nullable=True,
        server_default=OWNER_DEFAULT,
    )


def upgrade() -> None:
    op.create_table(
        "dashboard_layout",
        sa.Column("id", sa.Integer(), primary_key=True),
        _owner_column(),
        # Named so that a second dashboard is a UI change later rather than a
        # migration. v0 seeds exactly one, called Overview.
        sa.Column("name", sa.String(length=80), nullable=False, server_default="Overview"),
        sa.Column(
            "widgets",
            postgresql.JSONB().with_variant(sa.JSON(), "sqlite"),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("length(trim(name)) > 0", name="dashboard_layout_name_not_blank"),
    )
    op.create_index("ix_dashboard_layout_user_id", "dashboard_layout", ["user_id"])
    op.create_unique_constraint(
        "dashboard_layout_user_name_unique", "dashboard_layout", ["user_id", "name"]
    )
    _enable_rls("dashboard_layout")

    op.create_table(
        "session_allocation",
        sa.Column("id", sa.Integer(), primary_key=True),
        _owner_column(),
        sa.Column(
            "capacity_id",
            sa.Integer(),
            sa.ForeignKey("capacity.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("trackable_id", sa.Integer(), sa.ForeignKey("trackable.id"), nullable=True),
        sa.Column("milestone_id", sa.Integer(), sa.ForeignKey("milestone.id"), nullable=True),
        sa.Column("plan_date", sa.Date(), nullable=False),
        sa.Column("sessions", sa.Integer(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        # Same exactly-one rule weekly_commitment carries: an allocation that
        # targets both or neither is not a weaker record, it is a broken one.
        sa.CheckConstraint(
            "(trackable_id IS NOT NULL) <> (milestone_id IS NOT NULL)",
            name="session_allocation_exactly_one_target",
        ),
        sa.CheckConstraint("sessions >= 0", name="session_allocation_non_negative"),
    )
    op.create_index("ix_session_allocation_user_id", "session_allocation", ["user_id"])
    op.create_index("ix_session_allocation_capacity_id", "session_allocation", ["capacity_id"])
    op.create_index("ix_session_allocation_plan_date", "session_allocation", ["plan_date"])
    op.create_index(
        "session_allocation_trackable_unique",
        "session_allocation",
        ["capacity_id", "trackable_id", "plan_date"],
        unique=True,
        postgresql_where=sa.text("trackable_id IS NOT NULL"),
    )
    op.create_index(
        "session_allocation_milestone_unique",
        "session_allocation",
        ["capacity_id", "milestone_id", "plan_date"],
        unique=True,
        postgresql_where=sa.text("milestone_id IS NOT NULL"),
    )
    _enable_rls("session_allocation")

    # NULL means "we do not know when this finished", not "unfinished". Every
    # row that predates this migration is in that state, and the UI is required
    # to say so rather than draw a bar it invented.
    for table in ("goal", "milestone", "trackable"):
        op.add_column(table, sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    for table in ("goal", "milestone", "trackable"):
        op.drop_column(table, "completed_at")

    for table in TENANT_TABLES:
        op.execute(f"DROP POLICY IF EXISTS {table}_account_isolation ON {table}")
        op.execute(f"ALTER TABLE {table} NO FORCE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} DISABLE ROW LEVEL SECURITY")

    op.drop_index("session_allocation_milestone_unique", table_name="session_allocation")
    op.drop_index("session_allocation_trackable_unique", table_name="session_allocation")
    op.drop_index("ix_session_allocation_plan_date", table_name="session_allocation")
    op.drop_index("ix_session_allocation_capacity_id", table_name="session_allocation")
    op.drop_index("ix_session_allocation_user_id", table_name="session_allocation")
    op.drop_table("session_allocation")

    op.drop_constraint(
        "dashboard_layout_user_name_unique", "dashboard_layout", type_="unique"
    )
    op.drop_index("ix_dashboard_layout_user_id", table_name="dashboard_layout")
    op.drop_table("dashboard_layout")
