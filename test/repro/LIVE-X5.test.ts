// LIVE-X5: LiveGmail keeps an attachment only when Gmail labels it exactly application/pdf,
// image/png|jpeg|gif|webp or text/plain. Plenty of mailers (invoicing and quoting tools, scanners,
// some phone and desktop clients) send PDFs as application/octet-stream, and photos as image/jpg.
// Kiki then reports "nothing from <contractor> with an attachment in Gmail since Fo asked" while
// the revised quote is sitting in the inbox. FakeGmail only ever holds application/pdf.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { kvSet, openDb } from "../../server/db.ts";
import { GMAIL_READONLY, LiveGmail } from "../../server/google/gmail.ts";
import { GoogleAuth } from "../../server/google/oauth.ts";

const FROM = "quotes@oakline.example";

type TestPart = { filename: string; mimeType: string; headers?: { name: string; value: string }[]; size?: number };

function gmail(t: TestContext, parts: TestPart[]) {
  const db = openDb(":memory:");
  kvSet(db, "google.oauth.tokens", JSON.stringify({ access_token: "token", expires_at: Date.now() + 3_600_000, refresh_token: "refresh", scope: `https://www.googleapis.com/auth/drive ${GMAIL_READONLY}` }));
  const auth = new GoogleAuth(db, { clientId: "id", clientSecret: "secret", redirectUri: "http://localhost:8787/api/google/oauth/callback", scopes: ["https://www.googleapis.com/auth/drive"] });
  const real = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    asked.push(url.pathname + url.search);
    const body = url.pathname.endsWith("/messages")
      ? { messages: [{ id: "m1", threadId: "t1" }], resultSizeEstimate: 1 }
      : {
          id: "m1",
          threadId: "t1",
          internalDate: String(Date.parse("2026-10-17T15:04:00Z")),
          payload: {
            mimeType: "multipart/mixed",
            headers: [
              { name: "From", value: `Oakline Flooring <${FROM}>` },
              { name: "Subject", value: "Re: Question about your flooring quote Q-1042" },
            ],
            parts: [
              { partId: "0", mimeType: "text/plain", filename: "", body: { size: 52, data: Buffer.from("No, use the revised quote attached.").toString("base64url") } },
              ...parts.map((p, i) => ({ partId: String(i + 1), mimeType: p.mimeType, filename: p.filename, headers: p.headers ?? [], body: { attachmentId: `ANGjdJ-${i}`, size: p.size ?? 1834 } })),
            ],
          },
        };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = real;
    db.close();
  });
  return { gmail: new LiveGmail(auth), asked };
}

test("a PDF the contractor's mailer labelled application/octet-stream is still found, as a PDF", async (t) => {
  const { gmail: g } = gmail(t, [{ filename: "Oakline revised quote Q-1042-R1.pdf", mimeType: "application/octet-stream" }]);
  const found = await g.searchAttachments({ from: FROM, afterIso: "2026-10-17T14:00:00.000Z" });
  assert.deepEqual(
    found.map((a) => ({ filename: a.filename, mimeType: a.mimeType })),
    [{ filename: "Oakline revised quote Q-1042-R1.pdf", mimeType: "application/pdf" }],
  );
});

test("a phone photo labelled image/jpg is found too", async (t) => {
  const { gmail: g } = gmail(t, [{ filename: "IMG_4410.JPG", mimeType: "image/jpg" }]);
  const found = await g.searchAttachments({ from: FROM, afterIso: "2026-10-17T14:00:00.000Z" });
  assert.deepEqual(found.map((a) => a.filename), ["IMG_4410.JPG"]);
});

test("for comparison: the same PDF labelled application/pdf is found, and the query is the exact sender since Fo asked", async (t) => {
  const { gmail: g, asked } = gmail(t, [{ filename: "Oakline revised quote Q-1042-R1.pdf", mimeType: "application/pdf" }]);
  const found = await g.searchAttachments({ from: FROM, afterIso: "2026-10-17T14:00:00.000Z" });
  assert.equal(found.length, 1);
  assert.equal(new URL(`https://x${asked[0]}`).searchParams.get("q"), `from:${FROM} has:attachment after:${Date.parse("2026-10-17T14:00:00.000Z") / 1000 - 60}`);
});

test("the logo in the contractor's email signature isn't offered as the revised quote", async (t) => {
  // How Outlook and most business signatures send a logo: an inline image with a Content-ID.
  const logo = { name: "Content-Disposition", value: 'inline; filename="image001.png"' };
  const { gmail: g } = gmail(t, [
    { filename: "image001.png", mimeType: "image/png", size: 4210, headers: [logo, { name: "Content-ID", value: "<image001.png@01DB2A7C.5E1F9B30>" }] },
    { filename: "Oakline revised quote Q-1042-R1.pdf", mimeType: "application/pdf", headers: [{ name: "Content-Disposition", value: 'attachment; filename="Oakline revised quote Q-1042-R1.pdf"' }] },
  ]);
  const found = await g.searchAttachments({ from: FROM, afterIso: "2026-10-17T14:00:00.000Z" });
  assert.deepEqual(found.map((a) => a.filename), ["Oakline revised quote Q-1042-R1.pdf"]);
});
