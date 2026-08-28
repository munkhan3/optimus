"""Persistence and the bridge to the metrics engine.

Everything that writes lives here. The engine stays pure by never touching a
Session; this package is where rows become the engine's frozen dataclasses and
back again.
"""
