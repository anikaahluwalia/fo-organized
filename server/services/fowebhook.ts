/**
 * Fo's webhook. Fo's MCP connection is pull-only; a webhook registered in Wajo (Settings, Fo MCP,
 * Webhooks) gets a signed POST the moment a Fo conversation turn closes. Kiki uses one event: Fo
 * answered a text of yours (`conversation.reply` with trigger `inbound_text`), in whatever text
 * conversation it landed. That's the link Kiki couldn't make before: she then has Fo read that text
 * for the proposal waiting on you (see textreply.ts). A delivery Kiki can't verify does nothing.
 *
 * Deliveries follow Standard Webhooks: `webhook-id`, `webhook-timestamp` and `webhook-signature`
 * (`v1,<base64 HMAC-SHA256>` of `<id>.<timestamp>.<body>`). The secret lives in .env only.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { kvGet, kvSet } from "../db.ts";
import type { Ctx } from "./context.ts";
import { TEXT_CHANNELS } from "./textreply.ts";

const TOLERANCE_SECONDS = 5 * 60;

/** True when `signature` is a valid signature of the delivery with `secret`, sent within five minutes. */
export function verifyFoWebhook(secret: string, headers: { id?: string; timestamp?: string; signature?: string }, body: Buffer, nowSeconds = Date.now() / 1000): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > TOLERANCE_SECONDS) return false;
  // Standard Webhooks secrets are "whsec_" + base64 key bytes; anything else is used as given.
  const key = secret.startsWith("whsec_") ? Buffer.from(secret.slice(6), "base64") : Buffer.from(secret, "utf8");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.`).update(body).digest();
  return signature.split(" ").some((part) => {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) return false;
    const given = Buffer.from(sig, "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/**
 * A verified delivery. Retries keep their id, so each is handled once; the work happens in a job,
 * after Wajo has its answer.
 */
export function receiveFoEvent(ctx: Ctx, deliveryId: string, event: unknown): void {
  if (kvGet(ctx.db, `fo.webhook.${deliveryId}`)) return;
  kvSet(ctx.db, `fo.webhook.${deliveryId}`, new Date().toISOString());
  const e = event as { type?: unknown; occurredAt?: unknown; reply?: Record<string, unknown> };
  if (e?.type === "webhook.test") {
    kvSet(ctx.db, "fo.webhook.tested", new Date().toISOString());
    return;
  }
  if (e?.type !== "conversation.reply" || !e.reply) return;
  const { conversationId, runId, channel, trigger } = e.reply;
  if (trigger !== "inbound_text" || typeof conversationId !== "string" || typeof channel !== "string" || !TEXT_CHANNELS.has(channel)) return;
  const at = typeof e.occurredAt === "string" && !Number.isNaN(Date.parse(e.occurredAt)) ? e.occurredAt : new Date().toISOString();
  const key = `${conversationId}:${typeof runId === "string" ? runId : deliveryId}`;
  ctx.jobs.enqueue("text_hook", `text_hook:${key}`, { conversationId, channel, at, key });
}
