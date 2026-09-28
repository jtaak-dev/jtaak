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
