# Two stages: node builds the SPA, python serves it alongside the API from one
# origin. Same-origin means the bearer token and relative fetch paths behave
# identically in dev and production, and there is no CORS surface to get wrong.

FROM node:24-slim AS frontend
WORKDIR /build
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build


FROM python:3.13-slim AS runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PATH="/app/.venv/bin:$PATH"

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app

# Dependencies first: this layer is cached until the lockfile actually changes.
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY optimus/ ./optimus/
COPY migrations/ ./migrations/
COPY alembic.ini config.toml ./
COPY --from=frontend /build/dist ./frontend/dist

RUN uv sync --frozen --no-dev

EXPOSE 8080
CMD ["uvicorn", "optimus.api.main:app", "--host", "0.0.0.0", "--port", "8080"]
