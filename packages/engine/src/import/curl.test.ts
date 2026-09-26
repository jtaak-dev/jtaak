import { describe, expect, it } from 'vitest';
import { parseCurlCommand } from './curl';

describe('parseCurlCommand', () => {
  it('parses a bare GET curl command', () => {
    const config = parseCurlCommand('curl https://api.example.com/users');
    expect(config.method).toBe('GET');
    expect(config.url).toBe('https://api.example.com/users');
  });

  it('parses -X for an explicit method', () => {
    const config = parseCurlCommand('curl -X DELETE https://api.example.com/users/1');
    expect(config.method).toBe('DELETE');
  });

  it('defaults to POST when a body is present but no method is given', () => {
    const config = parseCurlCommand(`curl https://api.example.com/users -d '{"name":"x"}'`);
    expect(config.method).toBe('POST');
    expect(config.body).toEqual({ mode: 'raw', raw: '{"name":"x"}' });
  });

  it('parses headers, including quoted values with spaces', () => {
    const config = parseCurlCommand(
      `curl https://api.example.com/users -H 'Content-Type: application/json' -H "X-Custom: some value"`,
    );
    expect(config.headers).toEqual([
      { key: 'Content-Type', value: 'application/json', enabled: true },
      { key: 'X-Custom', value: 'some value', enabled: true },
    ]);
  });

  it('parses basic auth from -u', () => {
    const config = parseCurlCommand('curl -u alice:secret https://api.example.com/private');
    expect(config.auth).toEqual({ type: 'basic', basic: { username: 'alice', password: 'secret' } });
  });

  it('parses a realistic multi-line curl command copied from devtools', () => {
    const command = `curl 'https://api.example.com/orders' \\
  -X POST \\
  -H 'Content-Type: application/json' \\
  -H 'Authorization: Bearer abc.def.ghi' \\
  --data-raw '{"item":"widget","qty":2}'`;
    const config = parseCurlCommand(command);
    expect(config.method).toBe('POST');
    expect(config.url).toBe('https://api.example.com/orders');
    expect(config.headers).toContainEqual({ key: 'Authorization', value: 'Bearer abc.def.ghi', enabled: true });
    expect(config.body).toEqual({ mode: 'raw', raw: '{"item":"widget","qty":2}' });
  });

  it('ignores flags that do not affect the request shape', () => {
    const config = parseCurlCommand('curl -s -k -L https://api.example.com/users');
    expect(config.url).toBe('https://api.example.com/users');
    expect(config.method).toBe('GET');
  });
});
