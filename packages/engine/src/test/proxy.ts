import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

export interface TestProxy {
  url: string;
  /** What reached the proxy, in order: a CONNECT's `host:port`, or a forwarded request's absolute URL. */
  seen: { method: string; target: string; authorization?: string }[];
  close: () => Promise<void>;
}

/**
 * A local HTTP proxy for tests: it tunnels CONNECT requests and forwards
 * plain-HTTP ones sent to it in absolute form. With `credentials`
 * (`user:password`), it answers 407 to a request without them.
 */
export async function startTestProxy(options: { credentials?: string } = {}): Promise<TestProxy> {
  const seen: TestProxy['seen'] = [];
  const expected = options.credentials && `Basic ${Buffer.from(options.credentials).toString('base64')}`;
  const allowed = (req: http.IncomingMessage) => !expected || req.headers['proxy-authorization'] === expected;
  const sockets = new Set<net.Socket>();

  const server = http.createServer((req, res) => {
    seen.push({ method: req.method ?? '', target: req.url ?? '', authorization: req.headers['proxy-authorization'] });
    if (!allowed(req)) {
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="proxy"' }).end();
      return;
    }
    const target = new URL(req.url ?? '');
    const headers = { ...req.headers };
    delete headers['proxy-authorization'];
    const upstream = http.request(
      {
        host: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: req.method,
        headers,
      },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    upstream.on('error', () => res.writeHead(502).end());
    req.pipe(upstream);
  });
  server.on('connect', (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    seen.push({ method: 'CONNECT', target: req.url ?? '', authorization: req.headers['proxy-authorization'] });
    if (!allowed(req)) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="proxy"\r\n\r\n');
      return;
    }
    const [host, port] = (req.url ?? '').split(':');
    const upstream = net.connect(Number(port), host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    sockets.add(client).add(upstream);
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  server.on('connection', (socket) => sockets.add(socket));

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
