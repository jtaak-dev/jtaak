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

  it('reads --data-binary @file and --upload-file as a binary body', () => {
    const posted = parseCurlCommand(`curl https://api.example.com/f --data-binary '@C:/data/photo.png'`);
    expect(posted.method).toBe('POST');
    expect(posted.body).toEqual({ mode: 'binary', binaryPath: 'C:/data/photo.png' });

    const uploaded = parseCurlCommand('curl -T ./report.pdf https://api.example.com/f');
    expect(uploaded.method).toBe('PUT');
    expect(uploaded.body).toEqual({ mode: 'binary', binaryPath: './report.pdf' });

    expect(parseCurlCommand(`curl https://x.test --data-binary 'a=1'`).body).toEqual({ mode: 'raw', raw: 'a=1' });
  });

  it('reads -F parts as form-data, with @path parts as files', () => {
    const config = parseCurlCommand(
      `curl https://x.test/f -F 'note=hi' -F 'photo=@/data/a.png;type=image/png' --form-string 'raw=@not-a-file'`,
    );
    expect(config.method).toBe('POST');
    expect(config.body).toEqual({
      mode: 'form-data',
      formData: [
        { key: 'note', value: 'hi', enabled: true },
        { key: 'photo', value: '', enabled: true, type: 'file', src: '/data/a.png' },
        { key: 'raw', value: '@not-a-file', enabled: true },
      ],
    });
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
    const config = parseCurlCommand('curl -s -L https://api.example.com/users');
    expect(config.url).toBe('https://api.example.com/users');
    expect(config.method).toBe('GET');
    expect(config.verifyTls).toBeUndefined();
  });

  it('turns off the TLS certificate check for -k and --insecure', () => {
    expect(parseCurlCommand('curl -k https://self-signed.example').verifyTls).toBe(false);
    expect(parseCurlCommand('curl --insecure https://self-signed.example').verifyTls).toBe(false);
  });
});
