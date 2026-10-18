import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { ADJUST_SYSTEM_PROMPT, adjustUserMessage, ChangeRequestSchema, mockAdjust, type ChangeRequest, type ProposalItem } from "./domain/adjust.ts";
import { mockRead, READ_SYSTEM_PROMPT, ReadSchema, type DocFacts, type ReadResult } from "./domain/documents.ts";
import { PATTERN_SYSTEM_PROMPT, PatternSchema, patternUserMessage, type Pattern } from "./domain/lessons.ts";
import { mockInterpret, OUTCOME_SYSTEM_PROMPT, OutcomeSchema, outcomeUserMessage, verifyOutcome, type Outcome, type OutcomeContext } from "./domain/outcome.ts";
import { COMPOSE_SYSTEM_PROMPT, ComposeSchema, composeUserMessage, type ComposeFacts, type Composed } from "./domain/compose.ts";
import { pdfText } from "./domain/pdftext.ts";
import type { DriveContent } from "./google/types.ts";

/** Reads documents and interprets Fo conversation turns. Live = Claude; mock = labelled patterns. */
export interface Reader {
  readonly mode: "live" | "mock";
  read(content: DriveContent, fileName: string): Promise<ReadResult>;
  interpret(ctx: OutcomeContext): Promise<Outcome>;
  /** What the account holder's answer asks to change in a proposal (never whether to approve it). */
  interpretChange(items: ProposalItem[], reply: string): Promise<ChangeRequest>;
  /** A text for Fo to send you, written for the moment; null when Kiki should use her own (mock mode). Kiki checks it. */
  composeText(facts: ComposeFacts): Promise<Composed | null>;
  /** What kind of document you just filed somewhere, to recognize the next one; null in mock mode. Kiki checks it. */
  describeKind(name: string, facts: DocFacts | null, place: string): Promise<Pattern | null>;
}

export class ReadError extends Error {
  /** A passing problem (rate limit, overload, network): read again later instead of giving up. */
  readonly retryable: boolean;
  constructor(message: string, opts: { retryable?: boolean } = {}) {
    super(message);
    this.name = "ReadError";
    this.retryable = opts.retryable ?? false;
  }
}

/** Local text for checking quotes; null when the content has no text Kiki can see itself. */
export function localText(content: DriveContent): string | null {
  if (content.kind === "text") return content.text;
  if (content.kind === "pdf") return pdfText(content.data);
  return null;
}

export class MockReader implements Reader {
  readonly mode = "mock" as const;

  async read(content: DriveContent): Promise<ReadResult> {
    if (content.kind === "unsupported") throw new ReadError(content.reason);
    const text = localText(content);
    if (!text) throw new ReadError("Mock reading only works on files with plain text inside.");
    return mockRead(text);
  }

  async interpret(ctx: OutcomeContext): Promise<Outcome> {
    return verifyOutcome(ctx.message, mockInterpret(ctx));
  }

  async interpretChange(items: ProposalItem[], reply: string): Promise<ChangeRequest> {
    return mockAdjust(items, reply);
  }

  async composeText(): Promise<Composed | null> {
    return null;
  }

  async describeKind(): Promise<Pattern | null> {
    return null;
  }
}

function claudeError(err: unknown, model: string): ReadError {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new ReadError("Claude isn't configured on the server. Set ANTHROPIC_API_KEY in .env and restart, or run in mock mode.");
  }
  if (err instanceof Anthropic.NotFoundError) return new ReadError(`The Claude model "${model}" isn't available to this API key.`);
  if (err instanceof Anthropic.RateLimitError) return new ReadError("Claude is rate-limiting requests. Kiki will try again.", { retryable: true });
  if (err instanceof Anthropic.BadRequestError) return new ReadError(`Claude rejected the request: ${err.message}`);
  if (err instanceof Anthropic.InternalServerError) return new ReadError("Claude had a temporary problem. Kiki will try again.", { retryable: true });
  if (err instanceof Anthropic.APIConnectionError) return new ReadError("Couldn't reach Claude. Kiki will try again.", { retryable: true });
  if (err instanceof Anthropic.APIError) return new ReadError(`Claude request failed: ${err.message}`);
  return new ReadError(err instanceof Error ? err.message : String(err));
}

export class ClaudeReader implements Reader {
  readonly mode = "live" as const;
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(model: string, client?: Anthropic) {
    this.model = model;
    this.client = client ?? new Anthropic();
  }

  async read(content: DriveContent, fileName: string): Promise<ReadResult> {
    if (content.kind === "unsupported") throw new ReadError(content.reason);
    const intro = { type: "text" as const, text: `File name (also untrusted): ${JSON.stringify(fileName)}. Read the document and report its facts.` };
    const doc =
      content.kind === "pdf"
        ? { type: "document" as const, source: { type: "base64" as const, media_type: "application/pdf" as const, data: content.data.toString("base64") } }
        : content.kind === "image"
          ? { type: "image" as const, source: { type: "base64" as const, media_type: content.mimeType as "image/png" | "image/jpeg" | "image/gif" | "image/webp", data: content.data.toString("base64") } }
          : { type: "text" as const, text: `<document>\n${content.text.slice(0, 60_000)}\n</document>` };
    let response;
    try {
      response = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: 16000,
        system: READ_SYSTEM_PROMPT,
        messages: [{ role: "user", content: [doc, intro] }],
        output_config: { effort: "low", format: betaZodOutputFormat(ReadSchema) },
        // Server-side refusal fallback: if a safety classifier declines, the API retries on a fallback model.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
    } catch (err) {
      throw claudeError(err, this.model);
    }
    if (response.stop_reason === "refusal") throw new ReadError("Claude declined to read this file. Review it yourself.");
    if (response.stop_reason === "max_tokens") throw new ReadError("The document was too long to read in one pass.");
    if (!response.parsed_output) throw new ReadError("Claude's answer didn't match the expected format.");
    return response.parsed_output;
  }

  async interpret(ctx: OutcomeContext): Promise<Outcome> {
    let response;
    try {
      response = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: 4000,
        system: OUTCOME_SYSTEM_PROMPT,
        messages: [{ role: "user", content: outcomeUserMessage(ctx) }],
        output_config: { effort: "low", format: betaZodOutputFormat(OutcomeSchema) },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
    } catch (err) {
      throw claudeError(err, this.model);
    }
    if (response.stop_reason === "refusal") throw new ReadError("Claude declined to interpret this message. Read it yourself.");
    if (!response.parsed_output) throw new ReadError("Claude's answer didn't match the expected format.");
    return verifyOutcome(ctx.message, response.parsed_output);
  }

  async interpretChange(items: ProposalItem[], reply: string): Promise<ChangeRequest> {
    let response;
    try {
      response = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: 4000,
        system: ADJUST_SYSTEM_PROMPT,
        messages: [{ role: "user", content: adjustUserMessage(items, reply) }],
        output_config: { effort: "low", format: betaZodOutputFormat(ChangeRequestSchema) },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
    } catch (err) {
      throw claudeError(err, this.model);
    }
    if (response.stop_reason === "refusal") throw new ReadError("Claude declined to read this answer. Change the proposal in Kiki yourself.");
    if (!response.parsed_output) throw new ReadError("Claude's answer didn't match the expected format.");
    return response.parsed_output;
  }

  async describeKind(name: string, facts: DocFacts | null, place: string): Promise<Pattern | null> {
    let response;
    try {
      response = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: 1000,
        system: PATTERN_SYSTEM_PROMPT,
        messages: [{ role: "user", content: patternUserMessage(name, facts, place) }],
        output_config: { effort: "low", format: betaZodOutputFormat(PatternSchema) },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
    } catch (err) {
      throw claudeError(err, this.model);
    }
    return response.stop_reason === "refusal" ? null : (response.parsed_output ?? null);
  }

  async composeText(facts: ComposeFacts): Promise<Composed | null> {
    let response;
    try {
      response = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: 2000,
        system: COMPOSE_SYSTEM_PROMPT,
        messages: [{ role: "user", content: composeUserMessage(facts) }],
        output_config: { effort: "low", format: betaZodOutputFormat(ComposeSchema) },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
    } catch (err) {
      throw claudeError(err, this.model);
    }
    return response.stop_reason === "refusal" ? null : (response.parsed_output ?? null);
  }
}
