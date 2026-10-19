# Kiki's Chrome side panel

A small client of the Kiki app running on your computer, with the same look as the app (dark or light, following your system). It shows what needs you, what Kiki is working on, and what happened recently. From it you can approve a plan or set it aside, answer Fo's question, and point Kiki at the Drive folder you have open. The Kiki app does all the work in Google Drive; the panel never talks to Google itself.

## Load it in Chrome (Chrome 116 or newer)

1. Start Kiki: run `npm start` in the project folder. It serves the app at http://localhost:8787.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and choose this `extension` folder.
4. Pin Kiki from the extensions menu (the puzzle icon), then click her toolbar button to open the side panel.

After changing files here, click the reload icon on Kiki's card in `chrome://extensions`, then reopen the panel.

**Arc and other browsers without extension side panels:** the button still works. Kiki opens in a small window of her own (or as the button's popup where the browser has no side panel API at all). The window looks at the tab in your browser window, so "Organize this folder" still works for the Drive folder you have open.

## Pair it with Kiki

1. In the Kiki app, open **Settings**. Under **Chrome side panel**, click **Pair side panel**. Kiki shows a 6-digit code. It works once, expires after ten minutes, and five wrong tries cancel it.
2. Type the code in the side panel and click **Pair**.

The panel trades the code for a pairing key that only works for this extension's ID. It keeps the key in `chrome.storage.local` and nowhere else, and sends it with every request (`Authorization: Bearer …`). **Unpair** in the Kiki app revokes every paired panel, and the panel then asks for a new code. **Forget the pairing on this browser** (in the panel's **Settings**) only removes the key from this browser.

You can also make a code from a terminal while Kiki is running:

```bash
curl -s -X POST -H 'content-type: application/json' -d '{}' http://localhost:8787/api/extension/pairing-code
```

## What the panel shows

Top to bottom, with no tabs:

- **Kiki**: her face and her status line, the same as in the app. The panel refreshes every 2 seconds while it's open.
- **This Drive tab**, when your tab is a Google Drive folder outside the workspace: **Organize this folder**. If Kiki already has a workspace, the panel asks before switching. Kiki looks through the folder (read-only) and proposes a plan. Nothing moves until you approve.
- **Needs you**, only when something waits on you; otherwise "Nothing needs you right now." and **Check for anything new**:
  - a proposed plan: one row per change (old name → new name, and the folder), **Approve N changes**, and **Request a change** (when Fo asked you about the plan, your correction goes back through Fo) or **Open in Kiki**. **Approve** applies exactly the version on screen; clicking twice still approves once. **Not now** sets it aside, and nothing in Drive changes.
  - a question from Fo, with a box for your answer. Answering approves nothing.
  - a plan that stopped, with the steps that didn't finish and **Try again** or **Refresh the plan**.
  - a text that went wrong, or Drive or Fo not connected.
- **Working on it**: one line while Kiki applies a plan, reads files, or Fo is texting you.
- **Needs a look**: what Kiki noticed in the folder (a document others refer to that's missing, dates running out, unclear quotes), the same list as in the app, which has the details and actions.
- **Recent**: the last few plans, labelled **Applied and verified**, **Partly applied** (with how many steps were verified in Drive), **Failed**, **Stopped** or **You said no**, with the time. What Fo reports stays labelled as Fo's report. **Everything Kiki did** opens her log.
- The footer: when the panel last heard from Kiki, **Open Kiki**, **Settings** (the pairing, **Text me when Kiki finds something new**), Live or Mock for Drive and Fo, and the workspace folder.

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
- Kiki herself is drawn in `ui.js` from the same shapes as the app's `web/src/Kiki.tsx`. `icons/`: square versions of the approved mascot, on its own white background.
