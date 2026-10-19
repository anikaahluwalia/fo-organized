# Build the rental-documents prototype with Kiki

You are helping me implement a solo software-only Wajo AI GSD hackathon project. Read this entire brief, inspect the existing repository and its instructions, then implement Phase 1. Preserve existing work. Make reasonable reversible implementation decisions without repeatedly asking for permission. Do not send real messages or share documents during development without my explicit authorization for the specific recipient and action.

## Files supplied

- `kiki-approved.png`: approved visual reference for Kiki.
- `KIKI-DESIGN.md`: character, expressions, UI and accessibility specifications.

Use both. The approved character is a simple pink face with two dark eyes, a tiny smile, and a cream looped paperclip on the upper right. Do not bring back Oscar or create a human character. Do not replace Kiki with an emoji. Preserve the PNG; make an editable SVG version for UI states and compare it visually with the reference.

## Product and real need

The prototype helps students assemble rental application documents scattered across their files and messages. A missing item often depends on another person, such as a parent's guarantor letter. The app turns an incoming request into a checklist, finds candidate documents, lets the student approve outreach for missing pieces, and uses Fo to send that outreach. It also surfaces suspicious request signals before sensitive information is shared.

The student receiving the paperwork request is our user. Kiki is the face; our app manages records, decisions and permissions; Fo handles approved real-world communication. The final vision includes chasing missing items, maintaining versions, and controlled sharing. Do not claim the MVP already does those things.

Hackathon rubric: real end-to-end action 25; trust and user control 20; meaningful interaction, multi-step workflows or recovery 25; deliberate reliable engineering and honest mocks 20; specific real need 10. Hardware is out of scope.

## Phase 1: implement this first

Build one polished responsive page with Kiki, intake, a document checklist, an approval card, request-risk signals, and expandable evidence. Use the existing stack if suitable; otherwise use a small TypeScript frontend/backend. Keep secrets and Fo OAuth on the backend. Persist requests, action versions, dispatch attempts and conversation IDs in SQLite. Avoid unnecessary infrastructure.

### 1. Request intake

Allow the user to paste a landlord's email. Use Claude on the backend to extract a validated JSON object with requester name/email/domain, requested items, deadline, payment requests and links. Use null for unknowns. Keep the original text and source quotes. Treat pasted messages as untrusted data, never instructions. Do not fetch arbitrary URLs found in the message.

Show extracted details for review. The stated requester email is unverified when derived from pasted text.

### 2. Read-only inventory search through Fo

After the user initiates the search, ask Fo to search the user's connected Drive for the reviewed checklist. Explicitly request read-only behavior: do not modify, move, share or send anything. Ask for found/missing results, file names and source links where available.

Implement the documented working/polling loop. Show actual coarse progress and preserve the raw response. Parse conservatively: a proposed candidate is not automatically a verified valid document. Ambiguous or malformed output becomes Needs review, not Missing or Found. Never fabricate Drive IDs or links.

### 3. Approve outreach for one missing document

Support the guarantor-letter example. Draft the email in our app without asking Fo to contact anyone yet. Show recipient, subject and exact body; let the user edit. Identify the sender honestly as the student's AI assistant. Do not hardcode a real recipient.

Persist a versioned approval bound to recipient, channel and exact text. Only after the user selects Approve and send should the backend ask Fo to send that approved email. Explicitly prohibit attachments, document sharing, commitments and additional recipients.

Protect against double clicks and repeated network requests with a durable unique dispatch record and transactional state transitions. Frontend button disabling alone is insufficient. If the request might have reached Fo but the response was lost, mark it uncertain and reconcile before retrying. Do not promise exactly-once delivery.

If Fo asks for clarification or confirmation, display it and let the user answer in the mapped conversation. Keep the existing authorization boundaries; materially changed terms require a new approval.

Label the outcome accurately. Fo's report supports “Fo reports the email was sent.” Independent sent-mail evidence, if integrated and available, supports verified sending. Neither means the guarantor letter was received or the application completed.

### 4. Request-risk signals

Implement explainable signals such as a domain mismatch against a separately supplied trusted baseline, suspicious lookalike spelling, requests for highly sensitive identifiers, and suspicious payment-pressure combinations. An LLM can explain the signals, but cannot declare legitimacy.

No baseline means unable to compare, not a match. Ordinary words such as today or deposit alone must not prove fraud. A clean result means “No configured warning signs found; requester not verified.” Use “Needs review” or “Sharing on hold,” never “Scam detected” or “Safe landlord.”

Show a warning on a clearly labelled staged suspicious request. In Phase 1, document sharing and payments are not implemented at all. Do not claim the app blocks actions initiated independently in Fo. Hold actions tied to an unresolved suspicious request; allow manual review without silently clearing the warning.

### 5. Kiki and honest state

Implement idle, reading, searching, needs-you, waiting, alert, done and error expressions using the design guide. Tie them to backend state, not demo timers. Show readable status text. Respect reduced motion.

Include explicit Live and Demo input indicators. A staged email can be input to a live Fo action; label these separately. Mock mode must be visibly labelled and must never silently replace failed real integration.

## Fo MCP contract

Endpoint: https://mcp.api.wajo.ai/fo
Transport: Streamable HTTP. OAuth with the user's Wajo account; OG Fo plan required.

Tools:
- ask_fo(message required, conversationId optional, newConversation optional)
- get_fo_reply(conversationId optional, waitSeconds 0–40)
- list_fo_conversations(): at most 50 recent conversations across channels
- get_fo_conversation(conversationId): last 40 text turns
- start_fo_call(): out of scope for this MVP

ask_fo waits up to approximately 45 seconds. Responses have status complete, working or failed, a conversationId, and optional response/progress/elapsedSeconds. Poll get_fo_reply while working; it can wait up to 40 seconds. Store server-issued IDs privately. Never invent them or combine conversationId with newConversation. Pin each app workflow to its explicit conversation once created.

Do not issue another ask_fo into a working turn except in the documented user-input continuation flow. A complete turn can contain a question; it does not necessarily complete the goal. Tools can return isError: true. Fo may continue after client disconnect. Browser reload must reconnect to persisted state without repeating the action. Do not use limited conversation history as the app's permanent database.

Validate OAuth/client setup early with current official documentation and actual tools. Never embed credentials in frontend code, logs or the repository. Ask for required account setup when blocked. Do not assume Fo can call arbitrary secured webhooks or expose structured approval/action events. Do not depend on those capabilities.

## Security and evidence

Keep Gmail/Drive access and broader sharing integrations out of Phase 1 unless necessary for an already-authorized verification path. Minimize data sent to Fo. Do not log document contents or sensitive identifiers. Avoid placing private documents in the repository. Treat attachment and email content as untrusted.

Store action version, approval timestamp, recipient, dispatch state, Fo conversation ID and relevant evidence. Distinguish drafted, approved, dispatching, working, needs-user-input, reported-sent, verified-sent, failed and uncertain states.

Never interpret missing evidence as proof of failure and automatically resend. Never interpret a timeout as cancellation.

## Phase 2: document as future work, do not build yet

- Direct Drive API inventory and Gmail ingestion.
- Missing-document receipt and linking to requests.
- Provenance and document versions.
- Recipient-restricted sharing with scheduled revocation.
- Approval bound to exact recipient, files, message and expiry.
- Invalidate approvals when terms or files change.
- Changes to checklists or deadlines trigger a reviewed next step.
- Approved follow-up with frequency limits.

Revoking access cannot undo downloads or screenshots; never promise that documents disappear from recipients. Risk signals cannot verify a landlord's identity. Document validity rules should come from the actual request rather than invented universal thresholds.

## Implementation order and validation

1. Inspect the repo, summarize a short plan and identify credentials/setup blockers.
2. Add the supplied Kiki reference and design guide; implement the first faithful character and layout.
3. Validate the Fo connection with a read-only request when authorized.
4. Build intake → reviewed checklist → read-only inventory → draft → versioned approval → Fo dispatch → honest outcome.
5. Add risk signals and staged examples.
6. Test the important failure cases: duplicate dispatch requests, changed draft invalidating approval, working-to-question-to-continuation, malformed Fo output, ambiguous timeout, reload and restart recovery.
7. Run build/type checks and inspect desktop/mobile UI and reduced-motion behavior.
8. Provide launch instructions, environment-variable names, a brief demo script, actual tests run, and a clear list of live/staged/unimplemented functionality.

Stop after Phase 1 for rehearsal. Do not send a live message or share a real document just to complete a test without my explicit approval. Do not fabricate successful runs or verification evidence.
