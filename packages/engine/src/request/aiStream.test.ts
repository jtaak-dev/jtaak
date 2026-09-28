import { describe, expect, it } from 'vitest';
import { aiStreamText } from './aiStream';

const events = (...data: unknown[]) => data.map((d) => ({ data: typeof d === 'string' ? d : JSON.stringify(d) }));

describe('aiStreamText', () => {
  it("joins OpenAI chat completion chunks' deltas, up to [DONE]", () => {
    expect(
      aiStreamText(
        events(
          { object: 'chat.completion.chunk', choices: [{ delta: { role: 'assistant' } }] },
          { choices: [{ delta: { content: 'Hello' } }] },
          { choices: [{ delta: { content: ', world' } }] },
          { choices: [], usage: { prompt_tokens: 5 } },
          '[DONE]',
        ),
      ),
    ).toEqual({ format: 'openai-chat', text: 'Hello, world' });
  });

  it("joins Anthropic's text deltas, leaving out the other events", () => {
    expect(
      aiStreamText(
        events(
          { type: 'message_start', message: { usage: { input_tokens: 10 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'ping' },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Bonjour' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' !' } },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
          { type: 'message_stop' },
        ),
      ),
    ).toEqual({ format: 'anthropic', text: 'Bonjour !' });
  });

  it("reads OpenAI's Responses API and Gemini's streams", () => {
    expect(
      aiStreamText(
        events(
          { type: 'response.created', response: {} },
          { type: 'response.output_text.delta', delta: 'Hi' },
          { type: 'response.output_text.delta', delta: ' there' },
          { type: 'response.completed', response: {} },
        ),
      ),
    ).toEqual({ format: 'openai-responses', text: 'Hi there' });
    expect(
      aiStreamText(
        events(
          { candidates: [{ content: { parts: [{ text: 'Ciao' }], role: 'model' } }] },
          { candidates: [{ content: { parts: [{ text: ' mondo' }] } }], usageMetadata: {} },
        ),
      ),
    ).toEqual({ format: 'gemini', text: 'Ciao mondo' });
  });

  it('reads a whole (not streamed) answer too', () => {
    expect(aiStreamText(events({ choices: [{ message: { content: 'Whole' } }] }))).toEqual({
      format: 'openai-chat',
      text: 'Whole',
    });
    expect(aiStreamText(events({ type: 'message', content: [{ type: 'text', text: 'Entire' }] }))).toEqual({
      format: 'anthropic',
      text: 'Entire',
    });
  });

  it('is undefined for an ordinary event stream', () => {
    expect(aiStreamText(events('tick 1', { temperature: 21 }, '[DONE]'))).toBeUndefined();
    expect(aiStreamText([])).toBeUndefined();
  });
});
