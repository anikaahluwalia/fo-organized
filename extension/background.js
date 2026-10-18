// Clicking Kiki's toolbar button opens her side panel. The panel itself does everything else.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
