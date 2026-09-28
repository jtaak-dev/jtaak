// SOAP 1.1 and 1.2 over HTTP: an XML envelope POSTed with the version's
// content type and action. Browser-safe (no Node built-ins), so a UI can
// build the same request for code snippets, and read faults itself.
import type { KeyValue, RequestConfig, SoapProtocolConfig } from '../types.js';

export const SOAP_ENVELOPE_NAMESPACES = {
  '1.1': 'http://schemas.xmlsoap.org/soap/envelope/',
  '1.2': 'http://www.w3.org/2003/05/soap-envelope',
} as const;

/** A starting envelope for a version: a Header and a Body to fill in. */
export function soapEnvelopeTemplate(version: SoapProtocolConfig['version'] = '1.1'): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<soap:Envelope xmlns:soap="${SOAP_ENVELOPE_NAMESPACES[version]}">`,
    '  <soap:Header/>',
    '  <soap:Body>',
    '    <!-- The operation, for example: <m:GetPrice xmlns:m="https://example.com/prices"><m:Item>Apple</m:Item></m:GetPrice> -->',
    '  </soap:Body>',
    '</soap:Envelope>',
  ].join('\n');
}

const hasHeader = (headers: KeyValue[], name: string) =>
  headers.some((h) => h.enabled && h.key.trim().toLowerCase() === name.toLowerCase());

/**
 * A SOAP request as the HTTP request it's sent as: a POST of the envelope
 * (the request's raw body), with SOAP 1.1's `text/xml` and `SOAPAction`
 * header, or SOAP 1.2's `application/soap+xml` with an `action` parameter.
 * Headers the request sets itself are kept as they are.
 */
export function soapAsHttp(config: RequestConfig): RequestConfig {
  const soap = (config.protocolConfig as SoapProtocolConfig | undefined) ?? { version: '1.1' };
  const action = soap.action?.trim() ?? '';
  const headers = [...config.headers];
  if (!hasHeader(headers, 'content-type')) {
    const value =
      soap.version === '1.2'
        ? `application/soap+xml; charset=utf-8${action ? `; action="${action}"` : ''}`
        : 'text/xml; charset=utf-8';
    headers.push({ key: 'Content-Type', value, enabled: true });
  }
  if (soap.version !== '1.2' && !hasHeader(headers, 'soapaction')) {
    // SOAP 1.1 wants the header even when there's no action: "" then.
    headers.push({ key: 'SOAPAction', value: `"${action}"`, enabled: true });
  }
  return {
    ...config,
    protocol: 'http',
    method: 'POST',
    headers,
    body: { mode: 'raw', raw: config.body.raw ?? '' },
  };
}

/** A SOAP fault a response carries (SOAP 1.1 `faultcode`/`faultstring`, or 1.2 `Code`/`Reason`). */
export interface SoapFault {
  /** For example `soap:Client` (1.1) or `env:Sender` (1.2). */
  code: string;
  reason: string;
  /** The fault's detail element's content, as XML. */
  detail?: string;
}

const text = (xml: string) =>
  xml
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();

/** The content of the first element with this local name (any prefix), or undefined. */
function element(xml: string, localName: string): string | undefined {
  const match = new RegExp(
    `<(?:[\\w.-]+:)?${localName}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${localName}\\s*>`,
  ).exec(xml);
  return match?.[1];
}

/**
 * The fault in a SOAP response body, or undefined when there's none. Read
 * with patterns, not an XML parser, so it works anywhere; it finds the
 * first Fault element and its code, reason and detail.
 */
export function parseSoapFault(body: string): SoapFault | undefined {
  const fault = element(body, 'Fault');
  if (fault === undefined) return undefined;
  // SOAP 1.2: <Code><Value>…</Value></Code> and <Reason><Text>…</Text></Reason>.
  const code12 = element(fault, 'Code');
  const code =
    code12 !== undefined ? text(element(code12, 'Value') ?? code12) : text(element(fault, 'faultcode') ?? '');
  const reason12 = element(fault, 'Reason');
  const reason =
    reason12 !== undefined ? text(element(reason12, 'Text') ?? reason12) : text(element(fault, 'faultstring') ?? '');
  const detail = element(fault, 'Detail') ?? element(fault, 'detail');
  return { code, reason, ...(detail?.trim() && { detail: detail.trim() }) };
}
