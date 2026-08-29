"""Add areas of life and file goals under them.

An area is taxonomy, not a planning entity. It carries no definition of done, no
deadline and no stakes, and it never competes for time -- which is what separates
it from a Vision (vision.md §9), whose whole purpose is to sit above goals inside
the planning model.

Revision ID: 9c1e4b7a2d05
Revises: 7b4e9c5d2a1f
Create Date: 2026-08-28
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision: str = "9c1e4b7a2d05"
down_revision: str | None = "7b4e9c5d2a1f"
branch_labels = None
depends_on = None


OWNER_DEFAULT = sa.text("NULLIF(current_setting('app.user_id', true), '')::integer")


def upgrade() -> None:
    op.create_table(
        "area",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "user_id",
            sa.Integer(),
            sa.ForeignKey("app_user.id", ondelete="CASCADE"),
            nullable=True,
            server_default=OWNER_DEFAULT,
        ),
        sa.Column("name", sa.String(length=80), nullable=False),
        # Colour is derived from a stable ordering today (design.md's chromatic
        # set). The column exists so a per-area override becomes a UI change
        # rather than a migration.
        sa.Column("color", sa.String(length=32), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("length(trim(name)) > 0", name="area_name_not_blank"),
    )
    op.create_index("ix_area_user_id", "area", ["user_id"])
    # Two areas with the same name in one account is a mistake, not a feature.
    op.create_unique_constraint("area_user_name_unique", "area", ["user_id", "name"])

    # Areas hold operating data, so they need the same isolation as every other
    # tenant table: the SQLAlchemy loader filter alone is defence in depth, not
    # the boundary. The boundary is the row-level policy.
    op.execute("ALTER TABLE area ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE area FORCE ROW LEVEL SECURITY")
    op.execute(
        "CREATE POLICY area_account_isolation ON area "
        "USING (NULLIF(current_setting('app.user_id', true), '') IS NULL "
        "OR user_id = NULLIF(current_setting('app.user_id', true), '')::integer) "
        "WITH CHECK (NULLIF(current_setting('app.user_id', true), '') IS NULL "
        "OR user_id = NULLIF(current_setting('app.user_id', true), '')::integer)"
    )

    # SET NULL, never CASCADE: deleting an area un-files its goals. Losing real
    # planning data because a label was tidied away would be indefensible.
    op.add_column("goal", sa.Column("area_id", sa.Integer(), nullable=True))
    op.create_foreign_key(
        "goal_area_id_fkey", "goal", "area", ["area_id"], ["id"], ondelete="SET NULL"
    )
    op.create_index("ix_goal_area_id", "goal", ["area_id"])


def downgrade() -> None:
    op.drop_index("ix_goal_area_id", table_name="goal")
    op.drop_constraint("goal_area_id_fkey", "goal", type_="foreignkey")
    op.drop_column("goal", "area_id")

    op.execute("DROP POLICY IF EXISTS area_account_isolation ON area")
    op.execute("ALTER TABLE area NO FORCE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE area DISABLE ROW LEVEL SECURITY")
    op.drop_constraint("area_user_name_unique", "area", type_="unique")
    op.drop_index("ix_area_user_id", table_name="area")
    op.drop_table("area")
