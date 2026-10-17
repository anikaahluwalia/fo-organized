import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { EXTRACTION_SYSTEM_PROMPT, ExtractionSchema, extractionUserMessage, mockExtract, type Extraction } from "./domain/extraction.ts";

export interface Extractor {
  readonly mode: "live" | "mock";
  extract(rawText: string): Promise<Extraction>;
}

export class ExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractionError";
  }
}

export class MockExtractor implements Extractor {
  readonly mode = "mock" as const;
  async extract(rawText: string): Promise<Extraction> {
    return mockExtract(rawText);
  }
}

export class ClaudeExtractor implements Extractor {
  readonly mode = "live" as const;
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(model: string, client?: Anthropic) {
    this.model = model;
    this.client = client ?? new Anthropic();
  }

  async extract(rawText: string): Promise<Extraction> {
    let response;
    try {
      response = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: 16000,
        system: EXTRACTION_SYSTEM_PROMPT,
        messages: [{ role: "user", content: extractionUserMessage(rawText) }],
        output_config: { effort: "low", format: betaZodOutputFormat(ExtractionSchema) },
        // Server-side refusal fallback: if a classifier declines, the API retries on a fallback model.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
        throw new ExtractionError("Claude isn't configured on the server. Set ANTHROPIC_API_KEY and restart, or run in mock mode.");
      }
      if (err instanceof Anthropic.NotFoundError) throw new ExtractionError(`The Claude model "${this.model}" isn't available to this API key.`);
      if (err instanceof Anthropic.RateLimitError) throw new ExtractionError("Claude is rate-limiting requests right now. Try again in a minute.");
      if (err instanceof Anthropic.BadRequestError) throw new ExtractionError(`Claude rejected the request: ${err.message}`);
      if (err instanceof Anthropic.InternalServerError) throw new ExtractionError("Claude had a temporary problem. Try again.");
      if (err instanceof Anthropic.APIConnectionError) throw new ExtractionError("Couldn't reach Claude. Check the network and try again.");
      if (err instanceof Anthropic.APIError) throw new ExtractionError(`Claude request failed: ${err.message}`);
      throw new ExtractionError(`Couldn't read the request: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (response.stop_reason === "refusal") throw new ExtractionError("Claude declined to process this text. Review it yourself.");
    if (response.stop_reason === "max_tokens") throw new ExtractionError("The request was too long to read in one pass.");
    if (!response.parsed_output) throw new ExtractionError("Claude's answer didn't match the expected format.");
    return response.parsed_output;
  }
}
