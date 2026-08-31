/**
 * API client.
 *
 * Account access tokens are opaque, server-backed sessions stored locally after
 * registration or login.
 */

const TOKEN_KEY = "optimus.token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token.trim());
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body = await response.json();
      // FastAPI puts the human-readable reason in `detail`, and several of ours
      // are written to be shown verbatim (e.g. why a goal cannot be activated).
      detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {
      /* keep statusText */
    }
    throw new ApiError(response.status, detail);
  }

  if (response.status === 204) return undefined as T;

  try {
    return (await response.json()) as T;
  } catch {
    // A 200 that will not parse means the response was not JSON at all --
    // in practice the SPA shell, served because the endpoint does not exist on
    // the running server. Surfacing the raw parser error here ("the string did
    // not match the expected pattern") tells the user nothing; this does.
    throw new ApiError(
      response.status,
      `${path} did not return JSON. If this screen is new, the running server ` +
        `is probably older than the app — restart it.`,
    );
  }
}

/**
 * POST and read a Server-Sent Events response, yielding each parsed event.
 *
 * Not EventSource: that is GET-only and cannot carry the bearer header, and the
 * assistant needs a request body anyway.
 *
 * Streaming is what keeps long answers alive. A browser's request timeout
 * measures the gap between bytes rather than total duration, so a loop that
 * reports progress can run for minutes on a connection that would be killed at
 * 60 seconds of silence.
 */
export async function* stream<T>(path: string, body?: unknown): AsyncGenerator<T> {
  const token = getToken();
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });

  if (!response.ok || !response.body) {
    let detail = response.statusText;
    try {
      const parsed = await response.json();
      detail = typeof parsed.detail === "string" ? parsed.detail : JSON.stringify(parsed.detail);
    } catch {
      /* keep statusText */
    }
    throw new ApiError(response.status, detail);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Frames are separated by a blank line. The last element is a partial
    // frame and stays in the buffer until its terminator arrives.
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");
      // Comment frames (": keepalive") have no data line. They exist purely to
      // put bytes on the wire, so there is nothing to yield.
      if (data) yield JSON.parse(data) as T;
    }
  }
}

export const api = {
  get: <T,>(path: string) => request<T>(path),
  post: <T,>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) }),
  put: <T,>(path: string, body?: unknown) =>
    request<T>(path, { method: "PUT", body: JSON.stringify(body ?? {}) }),
  patch: <T,>(path: string, body?: unknown) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body ?? {}) }),
  delete: <T,>(path: string, body?: unknown) =>
    request<T>(path, { method: "DELETE", body: JSON.stringify(body ?? {}) }),
};
