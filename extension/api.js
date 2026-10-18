// Talks to the Kiki app on this computer. Every request carries the pairing token, when there is
// one, as "Authorization: Bearer". Errors come back as ApiError with a kind the panel acts on:
// offline (nothing answered), timeout, not_paired (401), http (Kiki said no, with its message),
// bad_response (something that isn't Kiki answered).

export class ApiError extends Error {
  constructor(message, { kind = "http", status = 0, code = null } = {}) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
    this.code = code;
  }
}

const isTimeout = (err) => err && (err.name === "TimeoutError" || err.name === "AbortError");

export function createApi({ base, fetch: fetchFn, getToken, timeoutMs = 15000 }) {
  async function request(method, path, body, timeout = timeoutMs) {
    const token = await getToken();
    const headers = { accept: "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const init = { method, headers, cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(timeout) };
    if (method === "POST") {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body ?? {});
    }
    let res;
    try {
      res = await fetchFn(`${base}${path}`, init);
    } catch (err) {
      if (isTimeout(err)) {
        throw new ApiError(method === "POST" ? "Kiki didn't answer in time. Check what happened before trying again." : "Kiki didn't answer in time.", { kind: "timeout" });
      }
      throw new ApiError("Kiki isn't answering on this computer.", { kind: "offline" });
    }
    let data = null;
    try {
      const text = await res.text();
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    const message = data && typeof data.error === "string" && data.error ? data.error : null;
    const code = data && typeof data.code === "string" ? data.code : null;
    if (res.status === 401) throw new ApiError(message ?? "Pair this side panel with Kiki first.", { kind: "not_paired", status: 401, code });
    if (!res.ok) throw new ApiError(message ?? `Kiki answered with an error (${res.status}).`, { kind: data ? "http" : "bad_response", status: res.status, code });
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new ApiError("Something other than Kiki answered at localhost:8787.", { kind: "bad_response", status: res.status });
    return data;
  }

  const plan = (id, action) => `/api/plans/${encodeURIComponent(id)}/${action}`;

  return {
    state: () => request("GET", "/api/state"),
    /** True when anything answers at the Kiki address. Sends no token and reads nothing. */
    async reachable() {
      try {
        await fetchFn(`${base}/api/state`, { method: "HEAD", cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(4000) });
        return true;
      } catch {
        return false;
      }
    },
    pair: (code) => request("POST", "/api/extension/pair", { code }),
    approve: (planId, contentHash, clientRequestId) => request("POST", plan(planId, "approve"), { contentHash, clientRequestId }),
    discard: (planId) => request("POST", plan(planId, "discard")),
    resume: (planId) => request("POST", plan(planId, "resume")),
    organize: () => request("POST", "/api/plans/organize"),
    // Selecting a folder asks Google Drive about it first, so it can take a little longer.
    selectFolder: (folder) => request("POST", "/api/workspace/select", { folder }, 45000),
    setAutoText: (on) => request("POST", "/api/settings", { autoText: Boolean(on) }),
  };
}
