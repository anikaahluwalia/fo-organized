# Kiki Chrome side panel — design prototype

## Try in Chrome
1. Open chrome://extensions.
2. Enable Developer mode.
3. Choose Load unpacked and select this `kiki-extension` directory.
4. Pin Kiki in Chrome's extensions menu.
5. Open Google Drive and click Kiki's toolbar button to open her side panel.

This package uses Chrome's native sidePanel API (Chrome 116+). It can be opened beside any website, including Drive. It requests only the sidePanel permission. It does not read the current Drive folder or access files, messages, or accounts. The panel always displays labelled sample renovation data.

## Working interactions
- Select proposed organizing operations, review, then approve simulated changes.
- Review a staged Fo conversation update and approve a document-version update.
- Inspect session activity and reset the demo.
- Ask field explains that live AI is not connected.

State is in memory and resets when the panel reloads. This is an interface prototype, not a live organizing agent.

## Files
`panel.html`, `panel.css`, `panel.js` are shared with the browser design preview. `kiki.png` is the approved mascot image. `manifest.json` and `background.js` provide the Chrome extension shell. No remote code, inline scripts, OAuth tokens or API keys are bundled.

## Next implementation work
Google OAuth + Drive API adapter; explicit workspace selection and access limits; durable proposals/approvals; verification and rollback records; backend Fo MCP OAuth and polling; evidence-based document matching. Do not substitute webpage clicking for Drive API operations.

The separate preview in `kiki-interface/dist` includes an illustrative Drive surface and reacts to panel approvals. That mockup is not part of the extension.

Reference: https://developer.chrome.com/docs/extensions/reference/api/sidePanel
