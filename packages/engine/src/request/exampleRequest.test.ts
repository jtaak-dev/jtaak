import { describe, expect, it } from 'vitest';
import type { RequestConfig } from '../types';
import { defaultExampleMatch, exampleQueryNames, exampleRequestFrom } from './exampleRequest';

const base: RequestConfig = {
  id: 'r1',
  name: 'Request',
  method: 'GET',
  url: '{{baseUrl}}/users/{{id}}',
  params: [],
  headers: [],
  body: { mode: 'none' },
  auth: { type: 'none' },
};

describe('exampleRequestFrom', () => {
  it('keeps an HTTP request as written, with its enabled params and headers, and no auth', () => {
    const request = exampleRequestFrom({
      ...base,
      params: [
        { key: 'view', value: 'full', enabled: true },
        { key: 'q', value: '{{term}} and more', enabled: true },
        { key: 'off', value: '1', enabled: false },
      ],
      headers: [
        { key: 'Accept', value: 'application/json', enabled: true },
        { key: 'X-Off', value: '1', enabled: false },
      ],
      auth: { type: 'bearer', bearer: { token: 'secret' } },
    });
    expect(request).toEqual({
      method: 'GET',
      url: '{{baseUrl}}/users/{{id}}?view=full&q={{term}}%20and%20more',
      headers: { Accept: 'application/json' },
      match: { query: ['view', 'q'] },
    });
  });

  it("appends to a URL's own query and keeps its fragment", () => {
    const params = [{ key: 'b', value: '2', enabled: true }];
    expect(exampleRequestFrom({ ...base, url: 'http://h/p?a=1#top', params }).url).toBe('http://h/p?a=1&b=2#top');
  });

  it('keeps a text body and matches on it; a GET has none', () => {
    const post = exampleRequestFrom({ ...base, method: 'POST', body: { mode: 'json', raw: '{"name":"{{name}}"}' } });
    expect(post).toMatchObject({ method: 'POST', body: '{"name":"{{name}}"}', match: { body: true } });
    expect(exampleRequestFrom({ ...base, body: { mode: 'raw', raw: 'ignored' } })).not.toHaveProperty('body');
    const form = exampleRequestFrom({
      ...base,
      method: 'POST',
      body: {
        mode: 'urlencoded',
        formData: [
          { key: 'a', value: 'x y', enabled: true },
          { key: 'b', value: '', enabled: false },
        ],
      },
    });
    expect(form.body).toBe('a=x%20y');
    const file = exampleRequestFrom({ ...base, method: 'POST', body: { mode: 'binary', binaryPath: 'f.bin' } });
    expect(file).not.toHaveProperty('body');
    expect(file).not.toHaveProperty('match');
  });

  it('turns GraphQL into the POST it is', () => {
    const request = exampleRequestFrom({
      ...base,
      protocol: 'graphql',
      protocolConfig: { query: 'query U { user { id } }', variables: { id: 1 }, operationName: 'U' },
    });
    expect(request).toEqual({
      method: 'POST',
      url: '{{baseUrl}}/users/{{id}}',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'query U { user { id } }', variables: { id: 1 }, operationName: 'U' }),
      match: { body: true },
    });
  });

  it('turns SOAP into the POST it is, with its action', () => {
    const request = exampleRequestFrom({
      ...base,
      protocol: 'soap',
      protocolConfig: { version: '1.1', action: 'urn:Get' },
      body: { mode: 'raw', raw: '<Envelope/>' },
    });
    expect(request).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '"urn:Get"' },
      body: '<Envelope/>',
    });
  });

  it('takes the match it is given', () => {
    expect(exampleRequestFrom(base, { headers: ['X-Tenant'] }).match).toEqual({ headers: ['X-Tenant'] });
    expect(exampleRequestFrom({ ...base, url: 'http://h/?a=1' }, {})).not.toHaveProperty('match');
  });
});

describe('the default match and query names', () => {
  it('names each query parameter once, decoded', () => {
    expect(exampleQueryNames('http://h/p?a=1&b%20c=2&a=3&flag#x?y=1')).toEqual(['a', 'b c', 'flag']);
    expect(exampleQueryNames('http://h/p')).toEqual([]);
  });

  it('matches on the query and a non-empty body', () => {
    expect(defaultExampleMatch({ method: 'POST', url: 'http://h/?a=1', headers: {}, body: ' ' })).toEqual({
      query: ['a'],
    });
    expect(defaultExampleMatch({ method: 'POST', url: 'http://h/', headers: {}, body: '{}' })).toEqual({ body: true });
  });
});
