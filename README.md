# Kiki

Kiki keeps a Google Drive workspace organized as work changes, with Fo (Wajo's assistant) handling communication. The document foundation supports business, academic, and personal collections. The renovation demo is one example, not the organizing model. General organization and the broader Fo-led correction workflow are being developed in stages; the current contractor/revision workflow is still quote-specific.

Brief: [docs/FO-RGANIZED-BRIEF.md](docs/FO-RGANIZED-BRIEF.md) · Character: [docs/KIKI-DESIGN.md](docs/KIKI-DESIGN.md) · Chrome side panel: [extension/](extension/)

## What it does

- **Organize a folder.** Kiki reads every document in one folder you choose (Claude reads the content; nothing is guessed), proposes folders and readable names with a reason for each, and after you approve, creates the folders, moves and renames the files, checks every change in Drive, and writes `<Project> - document index (kept by Kiki).csv`.
- **Notice new files.** Kiki watches the folder. When a new invoice or quote lands, she reads it, recognizes the supplier from what's already filed, and proposes where it goes.
- **Text you through Fo.** With "Text me when Kiki finds something new" on, Fo texts you what Kiki found. You answer in Kiki: yes, a change ("skip the second one"), or no. Approving by replying to the text comes later, once a text reply can be tied to the proposal it answers.
- **Ask a contractor if a quote is final.** From a quote in the index, Kiki drafts a short, honest email; you approve the exact message, and Fo sends it. Kiki then follows that Fo conversation, picks up the reply, finds the revised quote in Drive (asking you if two files could match), and proposes filing it as current, moving the old one to `Quotes/Superseded`, with the price and scope differences shown. "Current" never means "price accepted": you mark that yourself. If you already know which quote is current, say so ("This is the current one") and Kiki prepares the same reviewed change with you as the source.
- **Find the emailed revision.** If the contractor says "I emailed it" and it isn't in Drive, Kiki can look in Gmail (read-only, only once you allow it) for attachments from that contractor's exact address since Fo asked. Saving one into the folder waits for your click. If you drop the file into the folder yourself, she notices and links it without being asked again.
- **Point out what needs a look.** From what she read, Kiki lists documents that others refer to but that aren't in the folder (a deposit invoice for a quote you don't have), quotes and licences whose validity is running out, several quotes from one contractor with none marked current, and competing quotes with no price accepted, each with the line that supports it. Nothing there changes anything; "Got it" sets an item aside until the situation changes.
- **Ask for what's missing.** When a document refers to one that isn't in the folder (a deposit invoice for a quote you don't have), Kiki can draft a short request for a copy to whoever sent it. You approve the exact email, Fo sends it, and Kiki follows the conversation: she looks in Gmail for the attachment if you've allowed it (saving it waits for your click), or notices when the copy lands in the folder, then files it like any new document.
- **Chrome side panel.** Follow Kiki next to Google Drive: her status, the plan with each step's reason, approve or set it aside, "Organize this folder" for the Drive folder you have open, and Fo's latest text. It talks only to the Kiki app on this computer, after pairing with a one-time code.
- **Undo.** Any applied plan can be reversed (after its own approval) where nothing changed since; folders Kiki created stay, and nothing is ever deleted.

## Run it

```bash
npm install
npm start            # builds the web app and serves http://localhost:8787
npm run start:mock   # everything simulated and labelled Mock: no Google, Claude or Fo calls
```

Connect Google Drive and Fo from the top of the page, then set up the renovation folder or paste a Drive folder link.

**Side panel:** in `chrome://extensions`, turn on Developer mode, choose **Load unpacked** and pick the `extension` folder. Then click **Pair side panel** in the app and type the 6-digit code into the panel. Details in [extension/README.md](extension/README.md).

### Setup (`.env`, never committed)

| Variable | What for |
| --- | --- |
| `ANTHROPIC_API_KEY` | Claude reads documents and Fo messages. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google OAuth client of type "Web application", redirect URI `http://localhost:8787/api/google/oauth/callback`. Enable the Drive API; consent screen in Testing with your account as a test user. Testing consents expire after 7 days. |
| Gmail (optional) | To let Kiki find emailed revisions, enable the Gmail API in the same Google Cloud project and add the `gmail.readonly` scope to the consent screen. Kiki asks for it only when you press "Let Kiki look in Gmail (read-only)", on top of your existing Google sign-in. She never sends or changes mail. |
| `GOOGLE_DRIVE_SCOPES` | Optional. Default is the full `drive` scope, because moving files you added to Drive yourself needs it (with `drive.readonly` + `drive.metadata` + `drive.file`, Google refuses with "The user has not granted the app write access to the file"). `narrow` keeps that narrower set, which only works for files Kiki uploaded. Kiki is restricted to one folder by the app itself, not by the OAuth scope. |
| `KIKI_MODE`, `DRIVE_MODE`, `CLAUDE_MODE`, `FO_MODE` | `live` (default) or `mock`. Mock is labelled everywhere and never stands in for a live integration that fails. |
| `WORKSPACE_POLL_SECONDS`, `WATCH_INTERVAL_SECONDS` | How often Kiki looks at the folder (default 10 s live) and at a followed Fo conversation (default 30 s live). |

Fo signs in with your Wajo account from the app (OAuth with dynamic client registration and PKCE). Google and Fo tokens stay in `.data/` on this machine.

### Answering Fo's texts from your phone

A text reply to Fo starts a separate Fo conversation, so it can't be tied to Kiki's request. Instead, each text Fo sends you ends with a link to a small page for that one proposal ("Yes", "No", or a change or question in your own words). Your answer goes to Fo on the request's own conversation, so it stays linked, and Fo texts you what happens.

Your phone has to reach Kiki for that. Give Kiki a public https address with a tunnel, and put it in `.env`:

```bash
brew install cloudflared
cloudflared tunnel --url http://localhost:8787   # prints https://<random>.trycloudflare.com
# in .env:  KIKI_PUBLIC_URL=https://<random>.trycloudflare.com   then restart Kiki
```

The public address serves only the answer pages and Fo's webhook: each link is an unguessable, one-request token, and the app and its API stay reachable only from this machine. A quick tunnel's address changes every time it starts; update `.env` (and the webhook below) when it does.

### Replying to Fo's text directly (Fo's webhook)

With a Fo webhook, a plain text reply works too, in any thread you have with Fo. Wajo posts a signed event to Kiki the moment Fo answers a text of yours; if a proposal is waiting on you, Kiki has Fo read your text in her own conversation and report your decision there, bound to that exact proposal.

1. In Wajo: Settings, Fo MCP, Webhooks, "Add webhook", with the URL `<KIKI_PUBLIC_URL>/hooks/fo`.
2. Wajo shows the signing secret once. Put it in `.env` as `FO_WEBHOOK_SECRET=whsec_…` and restart Kiki.
3. Send the test event from Wajo; its delivery should show as succeeded.

Only deliveries signed with that secret, sent within the last five minutes, count; a retry of one is handled once. Without the secret, Kiki's texts say to answer at the link.

## Demo script (about 5 minutes)

Uses a dedicated test folder, never real business documents. Everything below also runs with `npm run start:mock`, labelled Mock.

1. **Messy folder.** Connect Google Drive and Fo, then press "Set up the renovation folder". Kiki adds five badly named PDFs (`scan_0012.pdf`, `invoice final FINAL.pdf`, …) to a new "Renovation paperwork" folder and reads them.
2. **Plan and approve.** Kiki proposes `Projects/Flooring/Quotes` and `/Invoices`, readable names, and a reason for each move. Approve it: she creates the folders, moves and renames the files, checks each change in Drive (9 of 9 verified) and writes the Flooring index. Open the folder in Drive to show the result.
3. **Needs a look.** Kiki points out that Oakline's quote is valid for 11 more days, the business licence expires at year end, and two contractors quoted flooring with no price accepted.
4. **A new invoice arrives.** Turn on "Text me when Kiki finds something new", then drag `demo-files/Northside invoice Oct 17.pdf` into the Drive folder. Kiki notices it, recognizes the supplier, proposes where it goes, and Fo texts you. Answer in Kiki (or click Approve) and she files it.
5. **Is this the final quote?** In the index, press "Ask Oakline Flooring Co. if it's final", confirm they agreed to hear from your assistant, and approve the exact email. Fo sends it; Kiki follows that Fo conversation.
6. **The answer.** When the contractor replies "No, use the revised quote I emailed today", Kiki looks for it in the folder, then in Gmail if you've allowed it (read-only), and proposes filing the revision as current with the old quote in `Quotes/Superseded`, showing the price and scope changes (−$470, 5-inch planks, carpet removal added). Approve, then open Drive.
7. **Recovery.** If two files could be the revision, Kiki asks which one and never guesses. Replaying any step makes no duplicates, and Undo reverses a plan after its own approval.

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

- One user and one workspace folder. Kiki files loose files (at the top of the workspace, or in catch-all folders like "Old scans"); anything in a folder you made stays put. A file goes into a folder you already keep when its name matches, otherwise into `Projects/<collection>/<document type>`, where one collection holds a project however its documents spell it. Existing legacy renovation project folders are reused.
- Recognized types now include notes, reports, research, assignments, presentations, spreadsheets, correspondence and itineraries as well as business documents. Classification does not add file-format support: unsupported formats remain unreadable.
- General document understanding has automated mock-based coverage; live extraction quality across these new types has not yet been evaluated. Replacement matching, current-version tracking and contractor outreach remain quote-specific.
- Existing stored classifications and project assignments are retained during the facts upgrade, so old files are not silently reclassified. New content reads use the general reader.
- Gmail is read-only and only searched for the contractor's exact address since Fo asked; attachments over 5 MB have to be saved into the folder by hand.
- How Fo records your text replies has only been exercised with the mock; approving in the app always works.
- The earlier Paper Chase prototype is preserved at the git tag `paper-chase-wip`; its brief is in `docs/archive/`.
