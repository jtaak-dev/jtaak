// The text an AI API streams back as Server-Sent Events (or returns in one
// JSON response), put together: OpenAI's chat completions and Responses API
// (and the many APIs compatible with them), Anthropic's Messages API and
// Google's Gemini. Browser-safe: a UI can build it from the events it shows.
import type { SseMessage } from '../types.js';

export type AiStreamFormat = 'openai-chat' | 'openai-responses' | 'anthropic' | 'gemini';

export interface AiStreamText {
  format: AiStreamFormat;
  /** The answer's text so far. */
  text: string;
}

function parse(data: string): Record<string, unknown> | undefined {
  if (!data || data === '[DONE]') return undefined;
  try {
    const value = JSON.parse(data) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

const get = (value: unknown, ...path: (string | number)[]): unknown =>
  path.reduce<unknown>(
    (at, key) => (at && typeof at === 'object' ? (at as Record<string | number, unknown>)[key] : undefined),
    value,
  );
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** The format of one message's JSON, and the text it adds. */
function piece(json: Record<string, unknown>): { format: AiStreamFormat; text: string } | undefined {
  const type = str(json.type);
  // Anthropic: content_block_delta with a text_delta; a whole message's content blocks.
  if (type === 'content_block_delta') {
    return { format: 'anthropic', text: str(get(json, 'delta', 'text')) ?? '' };
  }
  if (
    type &&
    ['message_start', 'message_delta', 'message_stop', 'content_block_start', 'content_block_stop', 'ping'].includes(
      type,
    )
  ) {
    return { format: 'anthropic', text: '' };
  }
  if (type === 'message' && Array.isArray(json.content)) {
    const text = (json.content as unknown[]).map((block) => str(get(block, 'text')) ?? '').join('');
    return { format: 'anthropic', text };
  }
  // OpenAI Responses API: response.output_text.delta, and the other response.* events.
  if (type === 'response.output_text.delta') return { format: 'openai-responses', text: str(json.delta) ?? '' };
  if (type?.startsWith('response.')) return { format: 'openai-responses', text: '' };
  if (json.object === 'response' && Array.isArray(json.output)) {
    const text = (json.output as unknown[])
      .flatMap((item) => (Array.isArray(get(item, 'content')) ? (get(item, 'content') as unknown[]) : []))
      .map((part) => (get(part, 'type') === 'output_text' ? (str(get(part, 'text')) ?? '') : ''))
      .join('');
    return { format: 'openai-responses', text };
  }
  // OpenAI chat completions: a chunk's delta, or a whole completion's message.
  if (Array.isArray(json.choices)) {
    const choice = (json.choices as unknown[])[0];
    const text =
      str(get(choice, 'delta', 'content')) ?? str(get(choice, 'message', 'content')) ?? str(get(choice, 'text')) ?? '';
    return { format: 'openai-chat', text };
  }
  // Gemini: candidates' content parts.
  if (Array.isArray(json.candidates)) {
    const parts = get(json, 'candidates', 0, 'content', 'parts');
    const text = Array.isArray(parts) ? parts.map((part) => str(get(part, 'text')) ?? '').join('') : '';
    return { format: 'gemini', text };
  }
  return undefined;
}

/**
 * The text an AI API's messages carry, joined in order, and which API's
 * format they're in; undefined when none of them is in a known format (an
 * ordinary event stream).
 */
export function aiStreamText(messages: Pick<SseMessage, 'data'>[]): AiStreamText | undefined {
  let format: AiStreamFormat | undefined;
  let text = '';
  for (const message of messages) {
    const json = parse(message.data);
    const found = json && piece(json);
    if (!found) continue;
    format ??= found.format;
    if (found.format === format) text += found.text;
  }
  return format ? { format, text } : undefined;
}

/** The tokens an AI API says a request used, and the model it named. */
export interface AiUsage {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** What one message's JSON says about usage and the model (each API puts them somewhere else). */
function usageIn(json: Record<string, unknown>): AiUsage {
  const found: AiUsage = {};
  const model =
    str(json.model) ??
    str(get(json, 'message', 'model')) ??
    str(get(json, 'response', 'model')) ??
    str(json.modelVersion);
  if (model) found.model = model.replace(/^models\//, '');
  // OpenAI chat completions: usage.prompt_tokens / completion_tokens (the last chunk, with stream_options.include_usage).
  // OpenAI Responses and Anthropic: usage.input_tokens / output_tokens (Responses: in response.usage; Anthropic:
  // message.usage at the start, usage.output_tokens in message_delta).
  const usage = (get(json, 'usage') ?? get(json, 'response', 'usage') ?? get(json, 'message', 'usage')) as unknown;
  if (usage && typeof usage === 'object') {
    const input =
      num(get(usage, 'prompt_tokens')) ??
      (num(get(usage, 'input_tokens')) !== undefined
        ? (num(get(usage, 'input_tokens')) ?? 0) +
          (num(get(usage, 'cache_read_input_tokens')) ?? 0) +
          (num(get(usage, 'cache_creation_input_tokens')) ?? 0)
        : undefined);
    const output = num(get(usage, 'completion_tokens')) ?? num(get(usage, 'output_tokens'));
    const total = num(get(usage, 'total_tokens'));
    if (input !== undefined) found.inputTokens = input;
    if (output !== undefined) found.outputTokens = output;
    if (total !== undefined) found.totalTokens = total;
  }
  // Gemini: usageMetadata.
  const metadata = get(json, 'usageMetadata');
  if (metadata && typeof metadata === 'object') {
    const input = num(get(metadata, 'promptTokenCount'));
    const output = num(get(metadata, 'candidatesTokenCount'));
    const total = num(get(metadata, 'totalTokenCount'));
    if (input !== undefined) found.inputTokens = input;
    if (output !== undefined) found.outputTokens = output;
    if (total !== undefined) found.totalTokens = total;
  }
  return found;
}

/**
 * The token usage an AI API reports in its messages (or a whole JSON
 * answer), with the model: the latest value of each, as later messages
 * update them (Anthropic's output tokens grow with each message_delta).
 * The total is input plus output when the API doesn't give one. Undefined
 * when no message reports usage.
 */
export function aiUsage(messages: Pick<SseMessage, 'data'>[]): AiUsage | undefined {
  const usage: AiUsage = {};
  let reported = false;
  for (const message of messages) {
    const json = parse(message.data);
    if (!json) continue;
    const found = usageIn(json);
    if (found.model && !usage.model) usage.model = found.model;
    for (const key of ['inputTokens', 'outputTokens', 'totalTokens'] as const) {
      if (found[key] !== undefined) {
        usage[key] = found[key];
        reported = true;
      }
    }
  }
  if (!reported) return undefined;
  if (usage.totalTokens === undefined && (usage.inputTokens !== undefined || usage.outputTokens !== undefined)) {
    usage.totalTokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  }
  return usage;
}

/** A model's price, in US dollars per million tokens. */
export interface AiModelPrice {
  /** The model id as the API names it; also matches its dated snapshots (`<model>-2025-04-14`, `<model>-20251001`). */
  model: string;
  inputPerMillion: number;
  outputPerMillion: number;
}

const SNAPSHOT_SUFFIX = /^(?:-\d{4}-\d{2}-\d{2}|-\d{8}|@\d{8})$/;

/** The price for a model: its own entry, or the entry its dated snapshot belongs to. Never a longer model's. */
export function aiModelPrice(model: string, prices: readonly AiModelPrice[]): AiModelPrice | undefined {
  const id = model.trim().toLowerCase();
  return (
    prices.find((price) => price.model.trim().toLowerCase() === id) ??
    prices.find((price) => {
      const base = price.model.trim().toLowerCase();
      return id.startsWith(base) && SNAPSHOT_SUFFIX.test(id.slice(base.length));
    })
  );
}

/** What a request's tokens cost at its model's price, in US dollars; undefined when the model isn't priced. */
export function aiCost(
  usage: AiUsage,
  prices: readonly AiModelPrice[],
): { cost: number; price: AiModelPrice } | undefined {
  if (!usage.model) return undefined;
  const price = aiModelPrice(usage.model, prices);
  if (!price) return undefined;
  const cost =
    ((usage.inputTokens ?? 0) * price.inputPerMillion + (usage.outputTokens ?? 0) * price.outputPerMillion) / 1_000_000;
  return { cost, price };
}
