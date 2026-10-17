import type { SseMessage, StreamEvent } from '../types.js';

// An SSE stream kept as a response example's body: the messages received, in
// the text/event-stream format, each after a `:delay <ms>` comment saying
// how long after the one before it came (the first: after the connection
// opened). Comments are ignored by SSE clients, so the body is a valid stream
// as it is; a mock server can replay it with its timing. Pure (in browser.ts).

/** The content type of an SSE example. */
export const SSE_CONTENT_TYPE = 'text/event-stream';

function fieldLines(name: string, value: string): string[] {
  return value.split(/\r\n|\r|\n/).map((line) => `${name}: ${line}`);
}

/** A stream's received messages as an SSE body, with the delays between them. */
export function sseExampleBody(events: readonly StreamEvent[]): string {
  const blocks: string[] = [];
  let last = events.find((e) => e.type === 'open')?.timestamp ?? events[0]?.timestamp ?? 0;
  for (const event of events) {
    if (event.type !== 'message') continue;
    const message = event.data as SseMessage | undefined;
    if (!message || typeof message.data !== 'string') continue;
    const delay = Math.max(0, Math.round(event.timestamp - last));
    last = event.timestamp;
    blocks.push(
      [
        `:delay ${delay}`,
        ...(message.event && message.event !== 'message' ? [`event: ${message.event}`] : []),
        ...(message.id ? [`id: ${message.id}`] : []),
        ...fieldLines('data', message.data),
      ].join('\n'),
    );
  }
  return blocks.length > 0 ? `${blocks.join('\n\n')}\n\n` : '';
}

/** An SSE body as the blocks to send and the delay before each (`:delay` comments; other text as it is). */
export function sseExampleBlocks(body: string): { delayMs: number; text: string }[] {
  return body
    .replace(/\r\n|\r/g, '\n')
    .split(/\n{2,}/)
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      let delayMs = 0;
      const lines = block.split('\n').filter((line) => {
        const delay = /^:delay (\d+)\s*$/.exec(line);
        if (delay) delayMs += Number(delay[1]);
        return !delay;
      });
      return { delayMs, text: lines.length > 0 ? `${lines.join('\n')}\n\n` : '' };
    });
}
