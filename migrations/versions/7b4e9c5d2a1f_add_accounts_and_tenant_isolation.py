"""Add password accounts and isolate all operating data by account.

Revision ID: 7b4e9c5d2a1f
Revises: 5f3867bf6ec7
Create Date: 2026-08-28
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision: str = "7b4e9c5d2a1f"
down_revision: str | None = "5f3867bf6ec7"
branch_labels = None
depends_on = None


TENANT_TABLES = (
    "goal",
    "milestone",
    "trackable",
    "task",
    "capacity",
    "goal_budget",
    "weekly_commitment",
    "work_session",
    "progress_check",
    "baseline",
    "open_gap",
    "daily_plan",
    "plan_item",
)
OWNER_DEFAULT = sa.text("NULLIF(current_setting('app.user_id', true), '')::integer")


def upgrade() -> None:
    op.create_table(
        "app_user",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("email", sa.String(length=320), nullable=False, unique=True),
        sa.Column("password_hash", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_app_user_email", "app_user", ["email"], unique=True)
    op.create_table(
        "auth_session",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("app_user.id", ondelete="CASCADE"), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False, unique=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_auth_session_user_id", "auth_session", ["user_id"])
    op.create_index("ix_auth_session_token_hash", "auth_session", ["token_hash"], unique=True)
    legacy_id = op.get_bind().execute(
        sa.text(
            "INSERT INTO app_user (email, password_hash, created_at) "
            "VALUES ('legacy@optimus.local', 'disabled', CURRENT_TIMESTAMP) RETURNING id"
        )
    ).scalar_one()

    # Existing single-user data has no owner and is intentionally left hidden.
    # New writes receive their owner from the authenticated request context.
    for table in TENANT_TABLES:
        op.add_column(table, sa.Column("user_id", sa.Integer(), nullable=True, server_default=OWNER_DEFAULT))
        op.create_foreign_key(f"{table}_user_id_fkey", table, "app_user", ["user_id"], ["id"], ondelete="CASCADE")
        op.create_index(f"ix_{table}_user_id", table, ["user_id"])
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")
        op.execute(
            f"CREATE POLICY {table}_account_isolation ON {table} "
            "USING (NULLIF(current_setting('app.user_id', true), '') IS NULL "
            "OR user_id = NULLIF(current_setting('app.user_id', true), '')::integer) "
            "WITH CHECK (NULLIF(current_setting('app.user_id', true), '') IS NULL "
            "OR user_id = NULLIF(current_setting('app.user_id', true), '')::integer)"
        )

    op.drop_index("ix_capacity_week_start", table_name="capacity")
    op.create_index("ix_capacity_week_start", "capacity", ["week_start"])
    op.create_unique_constraint("capacity_user_week_unique", "capacity", ["user_id", "week_start"])
    op.drop_index("ix_daily_plan_plan_date", table_name="daily_plan")
    op.create_index("ix_daily_plan_plan_date", "daily_plan", ["plan_date"])
    op.create_unique_constraint("daily_plan_user_date_unique", "daily_plan", ["user_id", "plan_date"])

    # Preserve the original single-user workspace until its owner creates a
    # password account. Registration claims these rows atomically.
    for table in TENANT_TABLES:
        op.get_bind().execute(
            sa.text(f"UPDATE {table} SET user_id = :legacy_id WHERE user_id IS NULL"),
            {"legacy_id": legacy_id},
        )


def downgrade() -> None:
    op.drop_constraint("daily_plan_user_date_unique", "daily_plan", type_="unique")
    op.drop_index("ix_daily_plan_plan_date", table_name="daily_plan")
    op.create_index("ix_daily_plan_plan_date", "daily_plan", ["plan_date"], unique=True)
    op.drop_constraint("capacity_user_week_unique", "capacity", type_="unique")
    op.drop_index("ix_capacity_week_start", table_name="capacity")
    op.create_index("ix_capacity_week_start", "capacity", ["week_start"], unique=True)

    for table in reversed(TENANT_TABLES):
        op.execute(f"DROP POLICY IF EXISTS {table}_account_isolation ON {table}")
        op.execute(f"ALTER TABLE {table} NO FORCE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} DISABLE ROW LEVEL SECURITY")
        op.drop_index(f"ix_{table}_user_id", table_name=table)
        op.drop_constraint(f"{table}_user_id_fkey", table, type_="foreignkey")
        op.drop_column(table, "user_id")

    op.drop_index("ix_auth_session_token_hash", table_name="auth_session")
    op.drop_index("ix_auth_session_user_id", table_name="auth_session")
    op.drop_table("auth_session")
    op.drop_index("ix_app_user_email", table_name="app_user")
    op.drop_table("app_user")
