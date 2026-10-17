# Fo-rganized: Kiki + Fo

Kiki keeps a Google Drive workspace organized as real work happens; Fo (Wajo's action agent) handles approved communication. Brief: [docs/FO-RGANIZED-BRIEF.md](docs/FO-RGANIZED-BRIEF.md) · Character: [docs/KIKI-DESIGN.md](docs/KIKI-DESIGN.md).

## Demo in 5 minutes

```bash
npm install
npm start            # builds the web app and serves http://localhost:8787
```

1. **Connect Google Drive** (top right), then **Create a staged demo folder in my Drive**. It holds synthetic invoices and quotes with messy names, labelled "Staged input".
2. Kiki reads every document (Claude, read-only). Ask for **an organizing plan**: every folder, move and rename is shown before and after, with a reason.
3. **Approve this plan.** Kiki re-checks each file against Drive right before acting, applies the change, and reads it back. Open the folder in Drive to see the result and the index CSV Kiki keeps.
4. **Let Fo tell me what Kiki did.** Approve the exact note; Fo sends it to you (the account holder) and nobody else.

Run everything offline and clearly labelled as mock: `npm run start:mock`.

## Setup (.env, never committed)

| Variable | What for |
| --- | --- |
| `ANTHROPIC_API_KEY` | Claude reads the documents (live). |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google OAuth client, type "Web application", redirect URI `http://localhost:8787/api/google/oauth/callback`. Enable the Drive API; consent screen in Testing with your account as a test user. |
| `GOOGLE_DRIVE_SCOPES` | Optional. Default asks for `drive.readonly` + `drive.metadata` + `drive.file` (read content, rename/move, create folders and the index; no rewriting existing files). `full` requests the single `drive` scope. Restricting Kiki to one folder is enforced by the app, not by the OAuth scope. |
| `KIKI_MODE`, `DRIVE_MODE`, `CLAUDE_MODE`, `FO_MODE` | `live` (default) or `mock`. Mock is always labelled and never replaces a failing live integration. |

Fo signs in with your Wajo account from the app (**Connect Fo**); tokens stay in `.data/` on this machine.

## Checks

`npm test` · `npm run typecheck`

The earlier Paper Chase prototype is preserved at the git tag `paper-chase-wip`; its brief is in `docs/archive/`. The Chrome side-panel prototype is in `extension/` (integration is next).
