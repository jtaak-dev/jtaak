import { describe, expect, it } from 'vitest';
import { aiCost, aiModelPrice, aiStreamText, aiUsage } from './aiStream';

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

describe('aiUsage', () => {
  it("reads OpenAI chat's usage chunk and model", () => {
    expect(
      aiUsage(
        events(
          { model: 'gpt-4o-mini-2024-07-18', choices: [{ delta: { content: 'Hi' } }] },
          {
            model: 'gpt-4o-mini-2024-07-18',
            choices: [],
            usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
          },
          '[DONE]',
        ),
      ),
    ).toEqual({ model: 'gpt-4o-mini-2024-07-18', inputTokens: 12, outputTokens: 5, totalTokens: 17 });
  });

  it("follows Anthropic's usage from message_start to the last message_delta, cached input included", () => {
    expect(
      aiUsage(
        events(
          {
            type: 'message_start',
            message: {
              model: 'claude-sonnet-5',
              usage: { input_tokens: 20, cache_read_input_tokens: 100, output_tokens: 1 },
            },
          },
          { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } },
          { type: 'message_delta', usage: { output_tokens: 7 } },
          { type: 'message_delta', usage: { output_tokens: 42 } },
        ),
      ),
    ).toEqual({ model: 'claude-sonnet-5', inputTokens: 120, outputTokens: 42, totalTokens: 162 });
  });

  it("reads OpenAI Responses' and Gemini's usage", () => {
    expect(
      aiUsage(
        events({
          type: 'response.completed',
          response: { model: 'gpt-5.4', usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 } },
        }),
      ),
    ).toEqual({ model: 'gpt-5.4', inputTokens: 3, outputTokens: 4, totalTokens: 7 });
    expect(
      aiUsage(
        events({
          modelVersion: 'gemini-2.5-flash',
          usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 2, totalTokenCount: 10 },
        }),
      ),
    ).toEqual({ model: 'gemini-2.5-flash', inputTokens: 8, outputTokens: 2, totalTokens: 10 });
  });

  it('is undefined when nothing reports usage', () => {
    expect(aiUsage(events({ choices: [{ delta: { content: 'Hi' } }] }))).toBeUndefined();
  });
});

describe('aiModelPrice and aiCost', () => {
  const prices = [
    { model: 'gpt-5', inputPerMillion: 1.25, outputPerMillion: 10 },
    { model: 'claude-haiku-4-5', inputPerMillion: 1, outputPerMillion: 5 },
  ];

  it("matches a model's own entry and its dated snapshots, never a longer model's", () => {
    expect(aiModelPrice('GPT-5', prices)?.model).toBe('gpt-5');
    expect(aiModelPrice('claude-haiku-4-5-20251001', prices)?.model).toBe('claude-haiku-4-5');
    expect(aiModelPrice('gpt-5-2025-08-07', prices)?.model).toBe('gpt-5');
    expect(aiModelPrice('gpt-5-pro', prices)).toBeUndefined();
    expect(aiModelPrice('gpt-5.4', prices)).toBeUndefined();
  });

  it('prices input and output tokens per million, and only for a priced model', () => {
    const result = aiCost({ model: 'gpt-5', inputTokens: 1000, outputTokens: 500 }, prices);
    expect(result?.cost).toBeCloseTo(0.00625, 10);
    expect(aiCost({ model: 'unknown-model', inputTokens: 1 }, prices)).toBeUndefined();
    expect(aiCost({ inputTokens: 1 }, prices)).toBeUndefined();
  });
});
