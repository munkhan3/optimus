"""LLM integration.

Two surfaces, both constrained by P1/D10: the database is the source of truth
and the model never writes to it.

  ingest.py     parses a brain dump into a PROPOSAL the user must approve (§22)
  tools.py      read-only queries over the metrics engine (§26)
  assistant.py  a chat loop restricted to those tools

There are no write tools in v0. That is not an oversight -- §34 gates write
access on demonstrated trust, and deadline changes and scope cuts stay manual
permanently, because those are the decisions the system exists to keep honest.
"""
