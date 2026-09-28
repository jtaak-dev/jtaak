import { describe, expect, it } from 'vitest';
import { findVariables, resolveVariables, resolveDeep } from './resolver';
import { emptyScopes, type VariableScope } from '../types';

describe('resolveVariables', () => {
  it('resolves a variable from the environment scope', () => {
    const scopes: VariableScope = { ...emptyScopes(), environment: { baseUrl: 'https://api.example.com' } };
    expect(resolveVariables('{{baseUrl}}/users', scopes)).toBe('https://api.example.com/users');
  });

  it('prefers local, then environment, then collection, then workspace, then global', () => {
    const scopes: VariableScope = {
      local: { token: 'local-token' },
      environment: { token: 'env-token' },
      collection: { token: 'collection-token' },
      workspace: { token: 'workspace-token' },
      global: { token: 'global-token' },
    };
    expect(resolveVariables('{{token}}', scopes)).toBe('local-token');
  });

  it('falls back down the chain when narrower scopes do not define the variable', () => {
    const scopes: VariableScope = { ...emptyScopes(), global: { region: 'us-east-1' } };
    expect(resolveVariables('{{region}}', scopes)).toBe('us-east-1');
  });

  it('leaves unresolved variables untouched so authors notice them', () => {
    expect(resolveVariables('{{missing}}', emptyScopes())).toBe('{{missing}}');
  });
});

describe('findVariables', () => {
  it('finds each variable with where it is and what resolves it, narrowest scope first', () => {
    const scopes = { ...emptyScopes(), environment: { host: 'api.dev' }, global: { host: 'api.prod', token: 't' } };
    expect(findVariables('https://{{host}}/x?t={{ token }}&u={{user}}', scopes)).toEqual([
      { name: 'host', start: 8, end: 16, value: 'api.dev', scope: 'environment' },
      { name: 'token', start: 21, end: 32, value: 't', scope: 'global' },
      { name: 'user', start: 35, end: 43 },
    ]);
    expect(findVariables('no variables', scopes)).toEqual([]);
  });
});

describe('resolveDeep', () => {
  it('resolves variables inside nested objects and arrays', () => {
    const scopes: VariableScope = { ...emptyScopes(), environment: { host: 'example.com' } };
    const input = { url: 'https://{{host}}/a', tags: ['{{host}}', 'static'] };
    expect(resolveDeep(input, scopes)).toEqual({ url: 'https://example.com/a', tags: ['example.com', 'static'] });
  });
});

describe('performance budget: resolving a request with 50 variables', () => {
  it('achieves under 2ms', () => {
    const variables: Record<string, string> = {};
    for (let i = 0; i < 50; i++) variables[`var${i}`] = `value-${i}`;
    const scopes: VariableScope = { ...emptyScopes(), environment: variables };

    const headers = Array.from({ length: 50 }, (_, i) => ({
      key: `X-Header-${i}`,
      value: `{{var${i}}}`,
      enabled: true,
    }));
    const request = {
      url: 'https://{{var0}}.example.com/{{var1}}',
      headers,
      body: { raw: JSON.stringify(variables).replace(/"value-(\d+)"/g, (_m, i) => `"{{var${i}}}"`) },
    };

    // Assert on the best-of-N rather than a single sample, for the same
    // reason as the executor budget test: isolating the operation's own
    // cost from incidental GC/OS-scheduler noise.
    const iterations = 20;
    const samples: number[] = [];
    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      resolveDeep(request, scopes);
      samples.push(performance.now() - start);
    }

    expect(Math.min(...samples)).toBeLessThan(2);
  });
});
