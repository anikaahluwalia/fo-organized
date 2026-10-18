# Kiki's Chrome side panel

A small client of the Kiki app running on your computer. It shows Kiki's status, the plan she proposes, progress while she applies it, and what Fo last texted you. From it you can approve a plan or set it aside, and point Kiki at the Drive folder you have open. The Kiki app does all the work in Google Drive; the panel never talks to Google itself.

## Load it in Chrome (Chrome 116 or newer)

1. Start Kiki: run `npm start` in the project folder. It serves the app at http://localhost:8787.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and choose this `extension` folder.
4. Pin Kiki from the extensions menu (the puzzle icon), then click her toolbar button to open the side panel.

After changing files here, click the reload icon on Kiki's card in `chrome://extensions`, then reopen the panel.

## Pair it with Kiki

1. In the Kiki app, under **Chrome side panel**, click **Pair side panel**. Kiki shows a 6-digit code. It works once, expires after ten minutes, and five wrong tries cancel it.
2. Type the code in the side panel and click **Pair**.

The panel trades the code for a pairing key that only works for this extension's ID. It keeps the key in `chrome.storage.local` and nowhere else, and sends it with every request (`Authorization: Bearer …`). **Unpair** in the Kiki app revokes every paired panel, and the panel then asks for a new code. **Forget the pairing on this browser** (in the panel's ··· menu) only removes the key from this browser.

You can also make a code from a terminal while Kiki is running:

```bash
curl -s -X POST -H 'content-type: application/json' -d '{}' http://localhost:8787/api/extension/pairing-code
```

## What the panel shows

- Kiki's status and state, the same as in the app. The panel refreshes every 2 seconds while it's open.
- The workspace folder, with **Open in Drive**, and how many files Kiki sees.
- When your tab is a Google Drive folder outside the workspace: **Organize this folder**. If Kiki already has a workspace, the panel asks before switching. Kiki looks through the folder (read-only) and proposes a plan. Nothing moves until you approve.
- The latest plan, with each step's before and after and Kiki's reason. **Approve** applies exactly the version on screen; clicking twice still approves once. **Not now** sets it aside, and nothing in Drive changes.
- Progress while Kiki applies the plan, then "Done: N of M changes verified in Drive." If a plan only partly finished or was stopped, the panel says so and offers **Try again** or **Refresh the plan**.
- The latest text through Fo: what it says, whether Fo reports it was sent, and your reply once Kiki reads it.
- **Needs a look**: what Kiki noticed in the folder (a document others refer to that's missing, dates running out, unclear quotes), the same list as in the app, which has the details and actions.
- **Text me when Kiki finds something new**, the same setting as in the app.
- **Activity**: Kiki's log, newest first.
- **Open Kiki** opens the full app.

Errors come straight from Kiki and are shown as she sent them. In mock mode (`npm run start:mock`), Drive and Fo are labelled Mock.

## Permissions and privacy

- `sidePanel`: the panel itself.
- `storage`: the pairing key, in `chrome.storage.local` only.
- `http://localhost:8787/*`: the Kiki app on this computer. The panel's content security policy also limits its network requests to this address.
- `https://drive.google.com/*`: lets the panel read the address and title of your active tab when it's Google Drive (`chrome.tabs.query`), without the broad `tabs` permission. The panel doesn't inject scripts, read pages or fetch anything from Google.

There's no remote code, inline script or `eval`. Text from the server is always inserted as text, and links can only point to Google Drive, Google Docs or the Kiki app.

## Troubleshooting

- **"I can't reach Kiki"**: start it with `npm start` in the project folder. The panel checks again every couple of seconds. It expects Kiki at http://localhost:8787. If you run Kiki on another `PORT` or `APP_ORIGIN`, change `KIKI_ORIGIN` in `lib.js` and the address in `manifest.json` (`host_permissions` and `content_security_policy`), then reload the extension.
- **Asked to pair again**: the app was unpaired, or this panel's key no longer works. Make a new code in the app.
- **Organize this folder isn't offered**: the tab has to show a folder (an address with `/folders/`). Folders inside the workspace aren't offered. Kiki already looks after them.

## Files

- `manifest.json`, `background.js` (opens the panel from the toolbar button), `panel.html`, `panel.css`.
- `panel.js`: storage, tabs, the refresh loop and actions. `start()` takes its dependencies as arguments, so the panel can run outside Chrome.
- `api.js`: requests to the Kiki app. `lib.js`: pure helpers (Drive folder addresses, safe links, wording, the view model). `ui.js`: builds the page with DOM nodes, never HTML strings.
- `kiki.png`: the approved mascot. `icons/`: square versions of it, on its own white background.
