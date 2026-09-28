import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseSoapFault, soapAsHttp, soapEnvelopeTemplate } from './soap';
import { executeRequest } from './executor';
import { generateSnippet } from '../codegen/snippets';
import type { RequestConfig, SoapProtocolConfig } from '../types';

const soap = (protocolConfig: SoapProtocolConfig, overrides: Partial<RequestConfig> = {}): RequestConfig => ({
  id: 's',
  name: 's',
  protocol: 'soap',
  method: 'GET',
  url: 'http://example.com/service',
  params: [],
  headers: [],
  body: { mode: 'raw', raw: '<soap:Envelope/>' },
  auth: { type: 'none' },
  protocolConfig,
  ...overrides,
});

describe('soapAsHttp', () => {
  it('POSTs a SOAP 1.1 envelope as text/xml with a quoted SOAPAction', () => {
    const http = soapAsHttp(soap({ version: '1.1', action: 'urn:GetPrice' }));
    expect(http).toMatchObject({ protocol: 'http', method: 'POST', body: { mode: 'raw', raw: '<soap:Envelope/>' } });
    expect(http.headers).toEqual([
      { key: 'Content-Type', value: 'text/xml; charset=utf-8', enabled: true },
      { key: 'SOAPAction', value: '"urn:GetPrice"', enabled: true },
    ]);
    // An empty action is still sent, as "".
    expect(soapAsHttp(soap({ version: '1.1' })).headers[1].value).toBe('""');
  });

  it('POSTs SOAP 1.2 as application/soap+xml with the action as a parameter', () => {
    expect(soapAsHttp(soap({ version: '1.2', action: 'urn:GetPrice' })).headers).toEqual([
      { key: 'Content-Type', value: 'application/soap+xml; charset=utf-8; action="urn:GetPrice"', enabled: true },
    ]);
  });

  it('keeps headers the request sets itself', () => {
    const own = soap(
      { version: '1.1', action: 'urn:X' },
      {
        headers: [
          { key: 'content-type', value: 'text/xml', enabled: true },
          { key: 'SOAPAction', value: 'custom', enabled: true },
        ],
      },
    );
    expect(soapAsHttp(own).headers.map((h) => h.value)).toEqual(['text/xml', 'custom']);
  });

  it('gives a template for each version', () => {
    expect(soapEnvelopeTemplate('1.1')).toContain('xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"');
    expect(soapEnvelopeTemplate('1.2')).toContain('xmlns:soap="http://www.w3.org/2003/05/soap-envelope"');
  });

  it('writes snippets for the HTTP request it is', () => {
    const curl = generateSnippet(soap({ version: '1.1', action: 'urn:A' }), 'curl');
    expect(curl).toContain("curl -X POST 'http://example.com/service'");
    expect(curl).toContain(`-H 'SOAPAction: "urn:A"'`);
  });
});

describe('parseSoapFault', () => {
  it('reads a SOAP 1.1 fault', () => {
    const body = `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><soap:Fault>
  <faultcode>soap:Client</faultcode>
  <faultstring>Item &amp; price not found</faultstring>
  <detail><e:Why xmlns:e="urn:e">No such item</e:Why></detail>
</soap:Fault></soap:Body></soap:Envelope>`;
    expect(parseSoapFault(body)).toEqual({
      code: 'soap:Client',
      reason: 'Item & price not found',
      detail: '<e:Why xmlns:e="urn:e">No such item</e:Why>',
    });
  });

  it('reads a SOAP 1.2 fault', () => {
    const body = `<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope"><env:Body><env:Fault>
  <env:Code><env:Value>env:Sender</env:Value><env:Subcode><env:Value>m:Bad</env:Value></env:Subcode></env:Code>
  <env:Reason><env:Text xml:lang="en">Bad request</env:Text></env:Reason>
</env:Fault></env:Body></env:Envelope>`;
    expect(parseSoapFault(body)).toEqual({ code: 'env:Sender', reason: 'Bad request' });
  });

  it('finds no fault in an ordinary response', () => {
    expect(
      parseSoapFault('<soap:Envelope><soap:Body><m:Price>1.90</m:Price></soap:Body></soap:Envelope>'),
    ).toBeUndefined();
    expect(parseSoapFault('{"not":"xml"}')).toBeUndefined();
  });
});

describe('executeRequest with a SOAP request', () => {
  let server: http.Server;
  let url: string;
  let seen: { method?: string; headers: http.IncomingHttpHeaders; body: string } | undefined;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        seen = { method: req.method, headers: req.headers, body };
        res.writeHead(200, { 'content-type': 'text/xml' }).end('<ok/>');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/svc`;
  });
  afterAll(() => server.close());

  it('sends the envelope as a POST with the SOAP headers', async () => {
    const response = await executeRequest(
      soap({ version: '1.1', action: 'urn:Go' }, { url, body: { mode: 'raw', raw: '<e/>' } }),
    );
    expect(response.body).toBe('<ok/>');
    expect(seen).toMatchObject({
      method: 'POST',
      body: '<e/>',
      headers: { 'content-type': 'text/xml; charset=utf-8', soapaction: '"urn:Go"' },
    });
  });
});
