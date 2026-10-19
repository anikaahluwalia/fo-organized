import type { AppView } from "../../shared/api.ts";
import { post } from "./api.ts";
import { ExtensionPairing } from "./ExtensionPairing.tsx";
import { Badge, connectFo, connectGoogle, type Act, type Theme } from "./ui.tsx";

function ThemeChoice({ theme, setTheme }: { theme: Theme; setTheme: (t: Theme) => void }) {
  return (
    <fieldset className="segmented">
      <legend className="visually-hidden">Theme</legend>
      {(["light", "dark", "system"] as const).map((t) => (
        <label key={t} className={`segmented__option ${theme === t ? "segmented__option--on" : ""}`}>
          <input type="radio" name="theme" value={t} checked={theme === t} onChange={() => setTheme(t)} />
          <span>{t === "light" ? "Light" : t === "dark" ? "Dark" : "System"}</span>
        </label>
      ))}
    </fieldset>
  );
}

export function Settings({ view, act, theme, setTheme }: { view: AppView; act: Act; theme: Theme; setTheme: (t: Theme) => void }) {
  const { drive, fo } = view.integrations;
  const ws = view.workspace;
  const liveDrive = drive.mode === "live" && drive.connection === "connected";
  return (
    <div className="settings">
      {ws && (
        <section className="setting" aria-labelledby="set-email">
          <h2 id="set-email">Email</h2>
          <label className="check">
            <input type="checkbox" checked={Boolean(view.settings.emailScout)} disabled={act.busy !== null} onChange={(e) => act.run("email-scout", () => post("/api/email-scout", { on: e.target.checked }))} />
            <span>Check my email for files</span>
          </label>
          <p className="muted">{fo.mode === "mock" ? "Mock Fo" : "Fo"} looks at 9:00 and 17:00 and texts you first. Files you say yes to come to this folder.</p>
          {view.settings.emailScout && (
            <div className="row">
              <button className="btn btn--small" disabled={act.busy !== null} onClick={() => act.run("email-check", () => post("/api/email-scout/check"))}>
                Check now
              </button>
            </div>
          )}
        </section>
      )}

      <section className="setting" aria-labelledby="set-theme">
        <h2 id="set-theme">Theme</h2>
        <ThemeChoice theme={theme} setTheme={setTheme} />
      </section>

      {ws && (
        <section className="setting" aria-labelledby="set-texts">
          <h2 id="set-texts">Texts</h2>
          <label className="check">
            <input type="checkbox" checked={Boolean(view.settings.autoText)} disabled={act.busy !== null} onChange={(e) => act.run("auto-text", () => post("/api/settings", { autoText: e.target.checked }))} />
            <span>Text me when Kiki finds something new</span>
          </label>
        </section>
      )}

      <section className="setting" aria-labelledby="set-learned">
        <h2 id="set-learned">What Kiki learned</h2>
        {view.lessons.length ? (
          <ul className="rows">
            {view.lessons.map((l) => (
              <li key={l.id} className="learned">
                <span>
                  {l.text} {l.auto && <Badge kind="plain">Files on her own</Badge>}
                </span>
                <span className="row">
                  {l.kind === "place" && (
                    <button className="btn btn--small" disabled={act.busy !== null} onClick={() => act.run(`alone-${l.id}`, () => post(`/api/lessons/${l.id}/alone`, { on: !l.auto }))}>
                      {l.auto ? "Ask me first" : l.offered ? "Yes, on her own" : "File on her own"}
                    </button>
                  )}
                  <button className="btn btn--small btn--quiet" disabled={act.busy !== null} onClick={() => act.run(`forget-${l.id}`, () => post(`/api/lessons/${l.id}/forget`))}>
                    Forget
                  </button>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">Nothing yet. When you tell Kiki where something goes, she remembers it here.</p>
        )}
      </section>

      <section className="setting" aria-label="Chrome side panel">
        <ExtensionPairing paired={view.extension?.paired} pairedAt={view.extension?.pairedAt ?? null} />
      </section>

      <section className="setting" aria-labelledby="set-google">
        <h2 id="set-google">Google account</h2>
        <div className="row">
          {drive.mode === "mock" ? (
            <Badge kind="mock">Mock Drive</Badge>
          ) : drive.connection === "connected" ? (
            <>
              <Badge kind="live">Live Drive</Badge>
              {drive.account && <span>{drive.account}</span>}
            </>
          ) : drive.connection === "not_configured" ? (
            <Badge kind="problem">Drive not set up</Badge>
          ) : (
            <button className="btn btn--small" onClick={() => connectGoogle(act)} disabled={act.busy !== null}>
              Connect Google Drive
            </button>
          )}
        </div>
        {drive.connection === "not_configured" && drive.message && <p className="muted small">{drive.message}</p>}
        {liveDrive && (drive.gmail === "connected" || drive.gmail === "not_connected") && (
          <div className="row">
            {drive.gmail === "connected" ? (
              <Badge kind="live">Gmail: read-only</Badge>
            ) : (
              <button className="btn btn--small" title="Kiki only searches for attachments from a contractor she asked. She never sends, changes or deletes mail." disabled={act.busy !== null} onClick={() => connectGoogle(act, true)}>
                Let Kiki look in Gmail (read-only)
              </button>
            )}
          </div>
        )}
        {drive.gmail === "mock" && (
          <div className="row">
            <Badge kind="mock">Mock Gmail</Badge>
          </div>
        )}
      </section>

      <section className="setting" aria-labelledby="set-fo">
        <h2 id="set-fo">Fo</h2>
        <div className="row">
          {fo.mode === "mock" ? (
            <Badge kind="mock">Mock Fo</Badge>
          ) : fo.connection === "connected" ? (
            <Badge kind="live">Live Fo</Badge>
          ) : (
            <button className="btn btn--small" disabled={act.busy !== null} onClick={() => connectFo(act)}>
              Connect Fo
            </button>
          )}
        </div>
        {fo.message && fo.connection !== "connected" && <p className="muted small">{fo.message}</p>}
      </section>

      {ws && (
        <section className="setting" aria-labelledby="set-folder">
          <h2 id="set-folder">Folder</h2>
          <p>
            {ws.name} {ws.origin === "staged_demo" && <Badge kind="demo">Staged demo files</Badge>}
          </p>
          <div className="row">
            <button className="btn btn--small" disabled={act.busy !== null} onClick={() => act.run("clear", () => post("/api/workspace/clear"))}>
              Change folder
            </button>
            {ws.mode === "mock" && (
              <button className="btn btn--small btn--quiet" disabled={act.busy !== null} onClick={() => act.run("stage-invoice", () => post("/api/workspace/stage-revision", { variant: "invoice" }))}>
                Add a staged demo invoice
              </button>
            )}
          </div>
        </section>
      )}

      {view.signedIn && (
        <section className="setting" aria-label="Sign out">
          <button className="btn btn--small" onClick={() => void post("/api/logout").finally(() => window.location.assign("/login"))}>
            Sign out
          </button>
        </section>
      )}
    </div>
  );
}
