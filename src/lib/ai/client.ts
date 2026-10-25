import Anthropic from "@anthropic-ai/sdk";

let client: Anthropic | null = null;

/** True when Claude-powered extraction and advice are configured. */
export function aiEnabled(): boolean {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

export function anthropic(): Anthropic {
  if (!client) client = new Anthropic({ maxRetries: 3 });
  return client;
}

export const MODEL = process.env.PLIMSOLL_MODEL || "claude-opus-5-5";

type Effort = "low" | "medium" | "high" | "xhigh" | "max";
const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

export function effort(envVar: string, fallback: Effort): Effort {
  const v = process.env[envVar] as Effort | undefined;
  return v && EFFORTS.includes(v) ? v : fallback;
}

/**
 * Server-side refusal fallback: if the model declines (e.g. a false positive
 * on a dual-use goods description), the API re-runs the request on
 * Anthropic's recommended fallback model inside the same call.
 */
export const FALLBACK: { betas: Anthropic.Beta.AnthropicBeta[]; fallbacks: "default" } = {
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default",
};

export class AiError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/** Translate SDK errors into messages a user can act on. */
export function describeAiError(err: unknown): AiError {
  if (err instanceof AiError) return err;
  if (err instanceof Anthropic.AuthenticationError) return new AiError("The Anthropic API key is invalid.", false);
  if (err instanceof Anthropic.PermissionDeniedError) return new AiError("The Anthropic API key lacks access to the configured model.", false);
  if (err instanceof Anthropic.RateLimitError) return new AiError("Claude is rate limited right now — retry in a minute.", true);
  if (err instanceof Anthropic.BadRequestError) return new AiError(`Claude rejected the request: ${err.message}`, false);
  if (err instanceof Anthropic.InternalServerError) return new AiError("Claude had a temporary error — retry shortly.", true);
  if (err instanceof Anthropic.APIConnectionError) return new AiError("Could not reach the Claude API.", true);
  if (err instanceof Anthropic.APIError) return new AiError(`Claude API error ${err.status}: ${err.message}`, (err.status ?? 500) >= 500);
  return new AiError(err instanceof Error ? err.message : String(err), false);
}
