# Kiki — approved character and UI direction

Use `kiki-approved.png` as the visual source of truth. It is an AI-generated concept image approved by the user, with an opaque white background. It is not a transparent sprite or an animation sheet.

## Identity

Kiki is the face of Paper Chase, a rental-document assistant built with Fo. She is a tiny pink agent: curious, capable, friendly, and careful with private information. Her signature is a real looped paperclip on the upper-right edge of her head.

Preserve the approved design:
- A wide, softly rounded pink blob, subtly asymmetric.
- Two dark chocolate oval eyes and a small curved smile.
- A cream looped paperclip outlined in chocolate, tilted diagonally on the upper right. It must read as an office paperclip, with open spaces between its loops.
- No hair, body, clothes, arms, legs, eyelashes, nose, or extra props.
- No purple. No glossy 3D treatment or elaborate shading.

## Production asset

First display the supplied PNG faithfully with object-fit: contain on white. Do not pretend its white background is transparency. For animation and clean scaling, create a separate editable SVG interpretation using the PNG as reference. Preserve the approved proportions and clip. Keep the original PNG untouched and show the SVG beside it for visual comparison before replacing it in the UI.

SVG groups: silhouette, left-eye, right-eye, mouth, paperclip. Use a consistent viewBox. The looped paperclip must have open interiors; do not replace it with a triangle or safety pin. No emoji substitutes. Render mascot SVGs at 32, 64, 160 and 320 pixels to inspect readability. If the small clip becomes muddy, simplify line weight rather than remove its loops.

Suggested starting colors (approximations, not sampled values):
- Kiki pink: #F29CAF
- Chocolate: #39241D
- Cream: #FFF6E5
- White canvas: #FFFFFF
- Pale pink UI surface: #FFF5F7
- Body text: #332B2E

Use dark text on light backgrounds; pink is decoration, not the only status signal.

## Expression and motion design

Every expression is tied to actual application state. Keep Kiki's silhouette and clip consistent. Use eyes, mouth, and subtle whole-character movement; do not add anatomy.

| State | Face | Motion | Copy example |
| --- | --- | --- | --- |
| Idle | Oval eyes, small smile | Occasional blink | Ready when you are. |
| Reading | Eyes angled slightly toward the request, neutral smile | Small downward tilt | Reading the request… |
| Searching | Eyes look gently left then right | Slow, restrained movement | Checking for your documents… |
| Needs you | Eyes attentive, small neutral smile | One gentle tilt on entry | Review this before I ask your mom. |
| Waiting | Relaxed eyes, neutral mouth | Mostly still | Waiting for your mom's reply. |
| Alert | Eyes attentive, short neutral mouth | Stop movement; no flashing | Something doesn't match. Review before sharing. |
| Done | Eyes become happy arcs, small smile | One brief upward bob | Message sent. View the evidence. |
| Error | Neutral eyes and mouth | Still | I couldn't verify that yet. |

Done means the displayed action has appropriate evidence, not that the whole rental application is complete. Never animate celebration based only on an elapsed timer. Fo-reported sending should be labelled as such until independently verified.

Respect prefers-reduced-motion. Never wiggle approval controls. Keep a readable state label next to the mascot; animation must not carry essential information. A decorative mascot should be aria-hidden when an adjacent label already conveys its meaning.

## Page design

A calm, near-monochrome app in dark or light, following the system unless you choose in Settings. Dark: near-black background, dark grey cards with a subtle border, white and grey text. Light: off-white and white surfaces, dark chocolate text (#33211C). Kiki's pink is the only accent (her name, the status badges); status colours (verified, needs review, failed) appear only as text or a thin line, never a coloured slab. One sans-serif family (the system font). No floating sparkles, confetti loops, gradient glass, or fabricated metrics.

Layout:
1. Sidebar: Kiki in a circle, "kiki" and her status line; Activity, Browse, Settings; at the bottom the Fo and Drive connection (Live or Mock) and the folder's name. On a phone it becomes a top bar with the nav as tabs.
2. Activity: breadcrumb, "Your Drive, organized.", one muted line, "Managing N folders" (opens the folder list and Change folder), then tabs: With Fo (what waits on you: a proposed plan, a question, an offer, a message draft), In progress (applying, Fo texting, waiting on a reply, reading), Completed (applied plans and everything Kiki did). Each item is a card: icon, type and time, a one-sentence headline, one muted sentence, a footer with who it's with and View details. Then Needs a look, Recently completed, and "Last checked" with Find a file.
3. A plan, opened from its card: breadcrumb, the status badge ("Awaiting your approval"), the plan's title, "Review exactly what Kiki will change.", one row per change (icon, a plain title like "Move and rename the invoice", the old and new name, the folder, the amount; a new folder is folded into the move), "Needs a folder" rows with Choose a folder, then Approve N changes (white pill in dark, chocolate in light), Request a change, and "Nothing changes until you approve."
4. A correction: "A small correction?", a labelled textarea, Send correction, and "Sending a correction doesn't approve any file changes."
5. Browse: each folder with its file count, Open in Drive, its files and its project index; then every file Kiki sees. Settings: theme, texts, what Kiki learned, the side panel, Google, Fo, the folder, sign out.

The answer page Fo's texts link to uses the same look, in the phone's own light or dark setting. Approve and send stays clearly separate from Change message and Not now; recipient and message are visible before approval. Mark Live, Demo input, and Mock explicitly.

## Voice and naming

Product: Paper Chase. Character: Kiki. Brand family: Fo-rganized. Optional tagline: Kiki's on the case. Hashtag: #StayFoRganized.

Keep ownership honest: Kiki is the interface, our app manages the workflow, and Fo executes approved communication. Use warm concrete language. Do not say a requester is safe or a scammer based on heuristics. Say which signals need review.
