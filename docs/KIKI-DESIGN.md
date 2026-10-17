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

Build one calm, responsive page, not a dense admin dashboard. Desktop: request and checklist in the main area; Kiki and the next decision in a companion panel. Mobile: Kiki and current status above the checklist, with the approval card inline.

Suggested hierarchy:
1. Paper Chase / With Kiki + Fo
2. Kiki and one honest status sentence
3. Paste a document request
4. Checklist: found / missing / needs review
5. Exact-message approval card
6. Evidence and activity, expandable

White canvas, pale pink cards, restrained cream accents, dark readable text, rounded corners, generous spacing. Use a system sans-serif font. No floating sparkles, confetti loops, gradient-heavy glass panels, or fabricated metrics.

Primary buttons use dark chocolate with white text. Clearly separate Approve and send from Change message and Not now. Recipient and message must be visible before approval. Mark Live, Demo input, and Mock explicitly.

## Voice and naming

Product: Paper Chase. Character: Kiki. Brand family: Fo-rganized. Optional tagline: Kiki's on the case. Hashtag: #StayFoRganized.

Keep ownership honest: Kiki is the interface, our app manages the workflow, and Fo executes approved communication. Use warm concrete language. Do not say a requester is safe or a scammer based on heuristics. Say which signals need review.
