import type { GrpcStreamMessage, StreamEvent } from '../types.js';

// A streaming gRPC call kept as a response example: its body is JSON naming
// the method's kind and the messages both ways, each with how long after the
// one before it went (the first: after the call opened), and for a
// bidirectional method, optional reply rules. The example's status is the
// call's (0 for OK), its statusText the details and its headers the server's
// metadata; its Content-Type header says it's a stream. A mock server replays
// the received messages with their timing, waiting for each sent one in turn,
// and answers what's left by the rules. Pure (in browser.ts).

/** The Content-Type header of a gRPC stream example. */
export const GRPC_STREAM_CONTENT_TYPE = 'application/x-grpc-stream+json';

export type GrpcStreamKind = 'server' | 'client' | 'bidi';

/** A message of the call, and how long after the one before it went. */
export interface GrpcStreamStep {
  direction: 'sent' | 'received';
  delayMs: number;
  message: Record<string, unknown>;
}

/**
 * A reply to a client's message: the first rule whose `match` the message
 * (as JSON) has, as text or a `/pattern/flags` (empty matches any), sends
 * its `reply`, a JSON message template.
 */
export interface GrpcStreamRule {
  match: string;
  reply: string;
  delayMs: number;
}

export interface GrpcStreamExample {
  kind: GrpcStreamKind;
  messages: GrpcStreamStep[];
  rules?: GrpcStreamRule[];
}

/** Whether an example's headers say it's a gRPC stream. */
export function isGrpcStreamExample(headers: Record<string, string>): boolean {
  return Object.entries(headers).some(
    ([name, value]) => name.toLowerCase() === 'content-type' && value.trim().toLowerCase() === GRPC_STREAM_CONTENT_TYPE,
  );
}

/** A streaming call's messages (its `message` events) as an example body. */
export function grpcStreamExampleBody(
  kind: GrpcStreamKind,
  events: readonly StreamEvent[],
  rules?: GrpcStreamRule[],
): string {
  const messages: GrpcStreamStep[] = [];
  let last = events.find((e) => e.type === 'open')?.timestamp ?? events[0]?.timestamp ?? 0;
  for (const event of events) {
    if (event.type !== 'message') continue;
    const data = event.data as GrpcStreamMessage | undefined;
    if (!data || (data.direction !== 'sent' && data.direction !== 'received') || !isObject(data.message)) continue;
    messages.push({
      direction: data.direction,
      delayMs: Math.max(0, Math.round(event.timestamp - last)),
      message: data.message,
    });
    last = event.timestamp;
  }
  const example: GrpcStreamExample = { kind, messages, ...(rules && rules.length > 0 && { rules }) };
  return JSON.stringify(example, null, 2);
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const KINDS: readonly string[] = ['server', 'client', 'bidi'];

/** Reads rules, keeping only what a rule can hold. */
export function grpcStreamRules(value: unknown): GrpcStreamRule[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isObject).map((rule) => ({
    match: typeof rule.match === 'string' ? rule.match : '',
    reply: typeof rule.reply === 'string' ? rule.reply : '',
    delayMs:
      typeof rule.delayMs === 'number' && Number.isFinite(rule.delayMs) ? Math.max(0, Math.round(rule.delayMs)) : 0,
  }));
}

/** A gRPC stream example's body, read; undefined when it isn't one. */
export function readGrpcStreamExample(body: string): GrpcStreamExample | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!isObject(parsed) || !KINDS.includes(parsed.kind as string) || !Array.isArray(parsed.messages)) return undefined;
  const messages = parsed.messages
    .filter(isObject)
    .filter((step) => (step.direction === 'sent' || step.direction === 'received') && isObject(step.message))
    .map((step) => ({
      direction: step.direction as GrpcStreamStep['direction'],
      delayMs:
        typeof step.delayMs === 'number' && Number.isFinite(step.delayMs) ? Math.max(0, Math.round(step.delayMs)) : 0,
      message: step.message as Record<string, unknown>,
    }));
  const rules = grpcStreamRules(parsed.rules);
  return { kind: parsed.kind as GrpcStreamKind, messages, ...(rules.length > 0 && { rules }) };
}

/** A stream example's body with its rules replaced (none: without rules). */
export function withGrpcStreamRules(body: string, rules: GrpcStreamRule[]): string {
  const example = readGrpcStreamExample(body);
  if (!example) throw new Error("This example isn't a gRPC stream.");
  const { rules: _old, ...rest } = example;
  const kept = grpcStreamRules(rules);
  return JSON.stringify({ ...rest, ...(kept.length > 0 && { rules: kept }) }, null, 2);
}
