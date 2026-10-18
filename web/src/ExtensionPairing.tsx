import { useEffect, useState } from "react";

interface PairingCode {
  code: string;
  expiresAt: string;
}

async function postJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: "{}" });
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  if (!res.ok) throw new Error(typeof body.error === "string" && body.error ? body.error : `Request failed (${res.status})`);
  return body as T;
}

interface PairedState {
  paired: boolean;
  /** When the newest side panel paired: a newer time means the code on screen was used. */
  pairedAt: string | null;
}

/** Whether any side panel is paired, and since when, from GET /api/state (null when it can't tell). */
async function fetchPaired(): Promise<PairedState | null> {
  try {
    const res = await fetch("/api/state", { cache: "no-store" });
    if (!res.ok) return null;
    const body = (await res.json()) as { extension?: { paired?: unknown; pairedAt?: unknown } };
    if (typeof body.extension?.paired !== "boolean") return null;
    return { paired: body.extension.paired, pairedAt: typeof body.extension.pairedAt === "string" ? body.extension.pairedAt : null };
  } catch {
    return null;
  }
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/**
 * Pairs Kiki's Chrome side panel with this app. "Pair side panel" makes a one-time 6-digit code
 * (valid for ten minutes) to type into the panel; "Unpair" revokes every paired panel. Pass
 * `paired` (GET /api/state's `extension.paired`) if the page already polls it; otherwise the
 * component asks the server itself.
 */
export function ExtensionPairing({ paired: pairedProp, pairedAt: pairedAtProp }: { paired?: boolean; pairedAt?: string | null } = {}) {
  const [pairing, setPairing] = useState<(PairingCode & { pairedBefore: boolean | null; pairedAtBefore: string | null }) | null>(null);
  const [checkedState, setChecked] = useState<PairedState | null>(null);
  const checked = checkedState?.paired ?? null;
  const pairedAt = pairedAtProp !== undefined ? pairedAtProp : (checkedState?.pairedAt ?? null);
  const [busy, setBusy] = useState<"code" | "unpair" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const paired = pairedProp ?? checked;

  useEffect(() => {
    if (pairedProp !== undefined) return;
    let live = true;
    void fetchPaired().then((p) => {
      if (live) setChecked(p);
    });
    return () => {
      live = false;
    };
  }, [pairedProp]);

  // While a code is showing: count down to its expiry, and notice when a panel pairs with it.
  useEffect(() => {
    if (!pairing) return;
    let live = true;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const watch =
      pairedProp === undefined
        ? setInterval(() => {
            void fetchPaired().then((p) => {
              if (live && p !== null) setChecked(p);
            });
          }, 2000)
        : null;
    return () => {
      live = false;
      clearInterval(tick);
      if (watch) clearInterval(watch);
    };
  }, [pairing, pairedProp]);

  // The code works once. A panel paired since it was made (a newer pairing time, or the first panel) used it.
  useEffect(() => {
    if (pairing && ((pairing.pairedBefore === false && paired === true) || (pairedAt !== null && pairedAt !== pairing.pairedAtBefore))) {
      setPairing(null);
      setNote("Side panel paired.");
    }
  }, [pairing, paired, pairedAt]);

  async function makeCode() {
    setBusy("code");
    setError(null);
    setNote(null);
    try {
      const code = await postJson<PairingCode>("/api/extension/pairing-code");
      setPairing({ ...code, pairedBefore: paired, pairedAtBefore: pairedAt });
      setNow(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function unpair() {
    setBusy("unpair");
    setError(null);
    setNote(null);
    try {
      await postJson("/api/extension/unpair");
      setPairing(null); // unpairing also cancels a code that hasn't been used
      setChecked({ paired: false, pairedAt: null });
      setNote("Unpaired. The side panel will ask for a new code.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const expiresAt = pairing ? Date.parse(pairing.expiresAt) : Number.NaN;
  const expired = pairing !== null && Number.isFinite(expiresAt) && expiresAt <= now;
  const showing = pairing !== null && !expired ? pairing : null;
  const minutesLeft = showing ? Math.max(1, Math.ceil((expiresAt - now) / 60_000)) : 0;

  return (
    <section className="card card--plain" aria-labelledby="extension-pairing-title">
      <div className="card-head">
        <h2 id="extension-pairing-title">Chrome side panel</h2>
        {paired !== null && <span className={`chip ${paired ? "chip--confirmed" : "chip--not_searched"}`}>{paired ? "Paired" : "Not paired"}</span>}
      </div>
      <p className="lede">See Kiki and approve her plans from a side panel next to Google Drive.</p>
      <div aria-live="polite">
        {showing && (
          <div className="notice notice--info" style={{ marginTop: 12 }}>
            <p>Type this code in Kiki's side panel:</p>
            <p style={{ fontFamily: "var(--mono)", fontSize: "2rem", fontWeight: 700, letterSpacing: "0.18em", margin: "6px 0" }}>
              <span aria-hidden="true">
                {showing.code.slice(0, 3)} {showing.code.slice(3)}
              </span>
              <span className="visually-hidden">{showing.code.split("").join(" ")}</span>
            </p>
            <p className="hint">
              Works once. Expires at {clock(showing.expiresAt)} (in {minutesLeft} min).
            </p>
          </div>
        )}
        {expired && (
          <div className="notice notice--warn" style={{ marginTop: 12 }}>
            <p>That code expired. Make a new one.</p>
          </div>
        )}
        {note && <p className="hint">{note}</p>}
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn btn--primary btn--small" disabled={busy !== null} onClick={() => void makeCode()}>
          {busy === "code" ? "Making a code…" : showing ? "Make a new code" : "Pair side panel"}
        </button>
        <button className="btn btn--quiet btn--small" disabled={busy !== null || paired === false} onClick={() => void unpair()}>
          {busy === "unpair" ? "Unpairing…" : "Unpair"}
        </button>
      </div>
    </section>
  );
}
