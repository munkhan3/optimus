"""Injected configuration for the metrics engine.

Every constant vision.md hand-sets lives in config.toml (§27) and arrives here.
The engine takes a MetricsConfig as an argument -- it never reads a global, and
it never hardcodes a tunable. Several of these are placeholders that the doc
expects to be replaced by measured values, so making them easy to change is the
point.

tomllib is stdlib, so loading here does not violate the purity rule.
"""

from __future__ import annotations

import tomllib
from dataclasses import dataclass, field
from pathlib import Path


@dataclass(frozen=True)
class PaceConfig:
    kappa: float = 5.0
    min_sessions_for_iqr: int = 5
    provisional_band_low: float = 0.5
    provisional_band_high: float = 2.0


@dataclass(frozen=True)
class CalibrationConfig:
    rolling_window_sessions: int = 20
    retroactive_weight: float = 0.5


@dataclass(frozen=True)
class StallConfig:
    threshold_sessions: int = 4
    movement_pct: float = 5.0


@dataclass(frozen=True)
class PlanningConfig:
    w_feasibility: float = 0.30
    w_urgency: float = 0.20
    w_stakes: float = 0.20
    w_unblocking: float = 0.10
    w_neglect: float = 0.10
    w_effort: float = 0.10
    urgency_horizon_days: int = 30
    neglect_cap_days: int = 14
    feasibility_pressure_window_sessions: int = 10
    effort_reference_minutes: int = 120
    stakes_min: int = 1
    stakes_max: int = 5


@dataclass(frozen=True)
class RedistributionConfig:
    catch_up_cap: float = 1.25


@dataclass(frozen=True)
class TierConfig:
    short_task_minutes: int = 15
    tier_b_score_threshold: float = 0.40


@dataclass(frozen=True)
class SessionConfig:
    minutes: int = 25


@dataclass(frozen=True)
class HealthConfig:
    w_feasibility: float = 0.50
    w_drift: float = 0.20
    w_deadline: float = 0.15
    w_recency: float = 0.15
    drift_tolerance_sessions: float = 5.0
    deadline_horizon_days: int = 30
    staleness_cap_days: int = 14


@dataclass(frozen=True)
class RebaselineConfig:
    material_drift_sessions: float = 2.0


@dataclass(frozen=True)
class MetricsConfig:
    session: SessionConfig = field(default_factory=SessionConfig)
    pace: PaceConfig = field(default_factory=PaceConfig)
    calibration: CalibrationConfig = field(default_factory=CalibrationConfig)
    stall: StallConfig = field(default_factory=StallConfig)
    planning: PlanningConfig = field(default_factory=PlanningConfig)
    redistribution: RedistributionConfig = field(default_factory=RedistributionConfig)
    tiers: TierConfig = field(default_factory=TierConfig)
    health: HealthConfig = field(default_factory=HealthConfig)
    rebaseline: RebaselineConfig = field(default_factory=RebaselineConfig)

    @classmethod
    def from_toml(cls, path: str | Path) -> MetricsConfig:
        with open(path, "rb") as fh:
            raw = tomllib.load(fh)
        return cls.from_dict(raw)

    @classmethod
    def from_dict(cls, raw: dict) -> MetricsConfig:
        def section(name: str, klass):
            data = raw.get(name, {})
            allowed = {f for f in klass.__dataclass_fields__}
            unknown = set(data) - allowed
            if unknown:
                raise ValueError(
                    f"config.toml [{name}] has unknown key(s): {sorted(unknown)}. "
                    "Every constant must be declared -- silent typos become silent defaults."
                )
            return klass(**data)

        return cls(
            session=section("session", SessionConfig),
            pace=section("pace", PaceConfig),
            calibration=section("calibration", CalibrationConfig),
            stall=section("stall", StallConfig),
            planning=section("planning", PlanningConfig),
            redistribution=section("redistribution", RedistributionConfig),
            tiers=section("tiers", TierConfig),
            health=section("health", HealthConfig),
            rebaseline=section("rebaseline", RebaselineConfig),
        )


DEFAULT = MetricsConfig()
