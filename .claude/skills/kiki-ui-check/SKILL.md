---
name: kiki-ui-check
description: Look at Kiki's web app and Chrome side panel in a real browser (screenshots at desktop and phone widths, overflow and layout checks, loading and pairing the extension in Chrome). Use after any change to web/, extension/ or user-facing text, and before reporting UI work as done.
---

# Checking Kiki's UI in a real browser

Never judge UI work from the code alone. Run a throwaway mock Kiki, look at it, then read the screenshots.

## 1. Start a mock Kiki (never port 8787)

```bash
node scripts/ui/mock-kiki.mjs 8796 --organized   # or --demo (proposal waiting), or no flag (empty)
```

Run it in the background; it prints `Mock Kiki ready at http://localhost:8796`. It uses fresh data in a temp folder and everything is labelled Mock. Port 8787 is the user's live app: only take read-only screenshots of it, never click or post.

To reach a particular state, drive the API like the UI does (`POST` with `content-type: application/json` and `origin: http://localhost:8796`), for example `/api/workspace/demo`, `/api/plans/<id>/approve`. In mock mode, "Add an invoice" (`/api/workspace/stage-revision`) adds a new file.

## 2. Screenshot desktop and phone

```bash
node scripts/ui/shot.mjs http://localhost:8796 /tmp/kiki-desktop.png 1280 1600
node scripts/ui/shot.mjs http://localhost:8796 /tmp/kiki-phone.png 390 2400
```

It uses real mobile emulation (headless windows can't go below 500px), prints `HORIZONTAL OVERFLOW` if the page is wider than the screen, and lists where each heading sits so you can check the card order without reading a tall image. Then read the PNGs: check spacing, wrapping of long file names, labels, and that nothing reads as a claim Kiki can't back.

## 3. The Chrome side panel

```bash
node scripts/ui/extension.mjs 8796 /tmp            # load, pair with a real code, screenshot
node scripts/ui/extension.mjs 8796 /tmp --approve  # also click Approve on a waiting plan
```

It copies `extension/`, points it at the mock's port, loads it into headless Chrome over the DevTools pipe (branded Chrome 137+ ignores `--load-extension`), pairs it and saves `panel-*.png`. It can't click the toolbar button itself: the button's logic (side panel, or a window where the browser shows no side panel, such as Arc) is covered by `test/extension-background.test.mjs`.

## 4. Clean up

Stop the mock: `pkill -f "scripts/ui/mock-kiki.mjs 8796"`, and check the port is free (`lsof -nP -iTCP:8796 -sTCP:LISTEN`).
