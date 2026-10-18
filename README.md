# Kiki

Kiki keeps a Google Drive folder organized as real work happens, and Fo (Wajo's assistant) keeps you posted. She was built for a small renovation business whose quotes, invoices, licences and permits end up scattered across Drive: Kiki files them into clear folders with clear names, keeps a project index current, and follows up on which quote is the current one, always with your approval.

Brief: [docs/FO-RGANIZED-BRIEF.md](docs/FO-RGANIZED-BRIEF.md) · Character: [docs/KIKI-DESIGN.md](docs/KIKI-DESIGN.md) · Chrome side panel: [extension/](extension/)

## What it does

- **Organize a folder.** Kiki reads every document in one folder you choose (Claude reads the content; nothing is guessed), proposes folders and readable names with a reason for each, and after you approve, creates the folders, moves and renames the files, checks every change in Drive, and writes `<Project> - document index (kept by Kiki).csv`.
- **Notice new files.** Kiki watches the folder. When a new invoice or quote lands, she reads it, recognizes the supplier from what's already filed, and proposes where it goes.
- **Text you through Fo.** With "Text me when Kiki finds something new" on, Fo texts you what Kiki found. Reply "go ahead" and Kiki files it, then Fo texts back that it's done. You can always approve in the app instead.
- **Ask a contractor if a quote is final.** From a quote in the index, Kiki drafts a short, honest email; you approve the exact message, and Fo sends it. Kiki then follows that Fo conversation, picks up the reply, finds the revised quote in Drive (asking you if two files could match), and proposes filing it as current, moving the old one to `Quotes/Superseded`, with the price and scope differences shown. "Current" never means "price accepted": you mark that yourself.
- **Undo.** Any applied plan can be reversed (after its own approval) where nothing changed since; folders Kiki created stay, and nothing is ever deleted.

## Run it

```bash
npm install
npm start            # builds the web app and serves http://localhost:8787
npm run start:mock   # everything simulated and labelled Mock: no Google, Claude or Fo calls
```

Connect Google Drive and Fo from the top of the page, then set up the renovation folder or paste a Drive folder link.

### Setup (`.env`, never committed)

| Variable | What for |
| --- | --- |
| `ANTHROPIC_API_KEY` | Claude reads documents and Fo messages. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google OAuth client of type "Web application", redirect URI `http://localhost:8787/api/google/oauth/callback`. Enable the Drive API; consent screen in Testing with your account as a test user. Testing consents expire after 7 days. |
| `GOOGLE_DRIVE_SCOPES` | Optional. Default is the full `drive` scope, because moving files you added to Drive yourself needs it (with `drive.readonly` + `drive.metadata` + `drive.file`, Google refuses with "The user has not granted the app write access to the file"). `narrow` keeps that narrower set, which only works for files Kiki uploaded. Kiki is restricted to one folder by the app itself, not by the OAuth scope. |
| `KIKI_MODE`, `DRIVE_MODE`, `CLAUDE_MODE`, `FO_MODE` | `live` (default) or `mock`. Mock is labelled everywhere and never stands in for a live integration that fails. |
| `WORKSPACE_POLL_SECONDS`, `WATCH_INTERVAL_SECONDS` | How often Kiki looks at the folder (default 10 s live) and at a followed Fo conversation (default 30 s live). |

Fo signs in with your Wajo account from the app (OAuth with dynamic client registration and PKCE). Google and Fo tokens stay in `.data/` on this machine.

## How it stays trustworthy

- **Read-only first.** Inventory and reading never change anything. Only an approved plan does.
- **Approval binds to an exact plan version.** Any edit makes a new version and the old approval no longer applies; double clicks resolve to one approval (unique request ids in SQLite, not just disabled buttons).
- **Checked right before and after each change.** Before moving a file Kiki re-reads it: if its name, folder or content changed since you previewed, she stops and asks for a refresh. After each change she reads it back and only then records it as done. The plan reports exactly how many steps were applied and verified.
- **Bound to one folder.** Source and destination folders are walked up to the workspace root live; shortcuts are never moved or followed.
- **No duplicates on replay or restart.** Proposing the same thing twice returns the same plan; folders are created with pre-generated IDs and adopted if a previous attempt already made them; a step interrupted mid-call is settled by reading Drive back, never by repeating it.
- **Honest about Fo.** "Fo reports it was sent" is never treated as verified; an email whose outcome is unknown is marked uncertain and is never resent automatically; Kiki checks the conversation read-only before you decide. Fo's paraphrase is labelled as such, distinct from the contractor's own quoted words.
- **Documents and messages are data, not instructions.** Text aimed at AI tools is flagged and ignored; requests inside replies (share files, pay, contact others) are never acted on.

## Architecture

- `server/google/` Drive adapter: live REST client with server-side OAuth, and `FakeDrive` (in-memory, failure injection) for tests and mock mode.
- `server/domain/` pure logic: document facts, naming, plan builders, version diffs and candidate matching, Fo outcome interpretation, Kiki's state.
- `server/services/` workspace inventory and reading, plans and the executor, contractor outreach, the Fo conversation watch, texts to you.
- `server/fo/` Fo MCP client (Streamable HTTP + OAuth) and the task engine (ask, poll, continue, recover, reconcile).
- `server/jobs.ts` durable SQLite job queue; `server/http.ts` local API (localhost only, Host/Origin/JSON checks; the Chrome side panel authenticates with a pairing token).
- `web/` React interface; `extension/` Chrome side panel.

## Checks

```bash
npm test
npm run typecheck
```

## Known limits

- One user, one workspace folder, renovation projects; quotes and invoices are the best-supported document types.
- Gmail isn't integrated: a revised quote has to be saved into the workspace folder (or pasted reply text used) before Kiki can file it.
- How Fo records your text replies has only been exercised with the mock; approving in the app always works.
- The earlier Paper Chase prototype is preserved at the git tag `paper-chase-wip`; its brief is in `docs/archive/`.
