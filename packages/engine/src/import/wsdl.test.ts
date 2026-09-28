import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { openDatabase } from '../storage/db';
import { getCollectionTree, getOrCreateDefaultWorkspace, getRequest } from '../storage/repository';
import { executeRequest } from '../request/executor';
import { importWsdl, loadWsdl, resolveLocation, wsdlRequests } from './wsdl';
import type { SoapProtocolConfig } from '../types';

// A document/literal service in the shape of the common public calculator:
// SOAP 1.1 and 1.2 ports plus an HTTP GET one, and a schema with optional,
// repeated, enumerated, attributed, derived and recursive types.
const CALCULATOR = `<?xml version="1.0" encoding="utf-8"?>
<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
  xmlns:soap12="http://schemas.xmlsoap.org/wsdl/soap12/" xmlns:http="http://schemas.xmlsoap.org/wsdl/http/"
  xmlns:s="http://www.w3.org/2001/XMLSchema" xmlns:tns="http://tempuri.org/" targetNamespace="http://tempuri.org/" name="Calculator">
  <wsdl:types>
    <s:schema elementFormDefault="qualified" targetNamespace="http://tempuri.org/">
      <s:element name="Add">
        <s:complexType>
          <s:sequence>
            <s:element minOccurs="1" maxOccurs="1" name="intA" type="s:int"/>
            <s:element minOccurs="1" maxOccurs="1" name="intB" type="s:int"/>
          </s:sequence>
        </s:complexType>
      </s:element>
      <s:element name="AddResponse"><s:complexType><s:sequence><s:element name="AddResult" type="s:int"/></s:sequence></s:complexType></s:element>
      <s:element name="Order" type="tns:Order"/>
      <s:complexType name="Base">
        <s:sequence><s:element name="id" type="s:long"/></s:sequence>
        <s:attribute name="version" type="s:string" use="required"/>
      </s:complexType>
      <s:complexType name="Order">
        <s:complexContent>
          <s:extension base="tns:Base">
            <s:sequence>
              <s:element name="status" type="tns:Status"/>
              <s:element name="note" type="s:string" minOccurs="0"/>
              <s:element name="line" type="tns:Line" maxOccurs="unbounded"/>
              <s:choice>
                <s:element name="card" type="s:string"/>
                <s:element name="invoice" type="s:boolean"/>
              </s:choice>
            </s:sequence>
          </s:extension>
        </s:complexContent>
      </s:complexType>
      <s:complexType name="Line">
        <s:sequence>
          <s:element name="sku" type="s:string"/>
          <s:element name="placed" type="s:dateTime"/>
          <s:element name="parent" type="tns:Line" minOccurs="0"/>
        </s:sequence>
      </s:complexType>
      <s:simpleType name="Status">
        <s:restriction base="s:string"><s:enumeration value="NEW"/><s:enumeration value="PAID"/></s:restriction>
      </s:simpleType>
    </s:schema>
  </wsdl:types>
  <wsdl:message name="AddSoapIn"><wsdl:part name="parameters" element="tns:Add"/></wsdl:message>
  <wsdl:message name="AddSoapOut"><wsdl:part name="parameters" element="tns:AddResponse"/></wsdl:message>
  <wsdl:message name="PlaceSoapIn"><wsdl:part name="parameters" element="tns:Order"/></wsdl:message>
  <wsdl:message name="AddHttpGetIn"><wsdl:part name="intA" type="s:string"/></wsdl:message>
  <wsdl:portType name="CalculatorSoap">
    <wsdl:operation name="Add"><wsdl:input message="tns:AddSoapIn"/><wsdl:output message="tns:AddSoapOut"/></wsdl:operation>
    <wsdl:operation name="Place"><wsdl:input message="tns:PlaceSoapIn"/></wsdl:operation>
  </wsdl:portType>
  <wsdl:portType name="CalculatorHttpGet">
    <wsdl:operation name="Add"><wsdl:input message="tns:AddHttpGetIn"/></wsdl:operation>
  </wsdl:portType>
  <wsdl:binding name="CalculatorSoap" type="tns:CalculatorSoap">
    <soap:binding transport="http://schemas.xmlsoap.org/soap/http"/>
    <wsdl:operation name="Add">
      <soap:operation soapAction="http://tempuri.org/Add" style="document"/>
      <wsdl:input><soap:body use="literal"/></wsdl:input>
    </wsdl:operation>
    <wsdl:operation name="Place">
      <soap:operation soapAction="http://tempuri.org/Place"/>
      <wsdl:input><soap:body use="literal"/></wsdl:input>
    </wsdl:operation>
  </wsdl:binding>
  <wsdl:binding name="CalculatorSoap12" type="tns:CalculatorSoap">
    <soap12:binding transport="http://schemas.xmlsoap.org/soap/http"/>
    <wsdl:operation name="Add">
      <soap12:operation soapAction="http://tempuri.org/Add"/>
      <wsdl:input><soap12:body use="literal"/></wsdl:input>
    </wsdl:operation>
  </wsdl:binding>
  <wsdl:binding name="CalculatorHttpGet" type="tns:CalculatorHttpGet">
    <http:binding verb="GET"/>
  </wsdl:binding>
  <wsdl:service name="Calculator">
    <wsdl:port name="CalculatorSoap" binding="tns:CalculatorSoap"><soap:address location="http://calc.test/calculator.asmx"/></wsdl:port>
    <wsdl:port name="CalculatorSoap12" binding="tns:CalculatorSoap12"><soap12:address location="http://calc.test/calculator.asmx"/></wsdl:port>
    <wsdl:port name="CalculatorHttpGet" binding="tns:CalculatorHttpGet"><http:address location="http://calc.test/calculator.asmx"/></wsdl:port>
  </wsdl:service>
</wsdl:definitions>`;

// rpc/literal, a SOAP header, and a schema imported from another file.
const RPC = `<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:t="urn:types" xmlns:tns="urn:stock" targetNamespace="urn:stock">
  <types>
    <xsd:schema targetNamespace="urn:stock">
      <xsd:import namespace="urn:types" schemaLocation="types.xsd"/>
    </xsd:schema>
  </types>
  <message name="GetQuote"><part name="symbol" type="xsd:string"/><part name="when" type="t:When"/></message>
  <message name="Auth"><part name="token" element="t:Token"/></message>
  <portType name="Stock"><operation name="GetQuote"><input message="tns:GetQuote"/></operation></portType>
  <binding name="StockBinding" type="tns:Stock">
    <soap:binding style="rpc" transport="http://schemas.xmlsoap.org/soap/http"/>
    <operation name="GetQuote">
      <soap:operation soapAction=""/>
      <input>
        <soap:body use="literal" namespace="urn:stock:ops"/>
        <soap:header message="tns:Auth" part="token" use="literal"/>
      </input>
    </operation>
  </binding>
  <service name="StockService"><port name="StockPort" binding="tns:StockBinding"><soap:address location="https://stock.test/soap"/></port></service>
</definitions>`;

const TYPES = `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:types" elementFormDefault="qualified">
  <xs:element name="Token" type="xs:string"/>
  <xs:complexType name="When"><xs:sequence><xs:element name="day" type="xs:date"/></xs:sequence></xs:complexType>
</xs:schema>`;

describe('wsdlRequests', () => {
  it('makes a request per operation for each SOAP port, with the endpoint, version and action, and skips HTTP ports', () => {
    const { name, services, warnings } = wsdlRequests(CALCULATOR);
    expect(name).toBe('Calculator');
    expect(services).toHaveLength(1);
    expect(services[0].ports.map((p) => [p.name, p.requests.map((r) => r.name)])).toEqual([
      ['CalculatorSoap (SOAP 1.1)', ['Add', 'Place']],
      ['CalculatorSoap12 (SOAP 1.2)', ['Add']],
    ]);
    expect(warnings).toEqual(['Port "CalculatorHttpGet" of "Calculator" isn\'t a SOAP port; left out.']);
    const [add] = services[0].ports[0].requests;
    expect(add).toMatchObject({ protocol: 'soap', method: 'POST', url: 'http://calc.test/calculator.asmx' });
    expect(add.protocolConfig).toEqual({ version: '1.1', action: 'http://tempuri.org/Add' });
    expect(services[0].ports[1].requests[0].protocolConfig).toEqual({
      version: '1.2',
      action: 'http://tempuri.org/Add',
    });
  });

  it('builds the envelope from the input element, qualified as the schema says', () => {
    const add = wsdlRequests(CALCULATOR).services[0].ports[0].requests[0];
    expect(add.body.raw).toBe(`<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="http://tempuri.org/">
  <soap:Header/>
  <soap:Body>
    <tns:Add>
      <tns:intA>0</tns:intA>
      <tns:intB>0</tns:intB>
    </tns:Add>
  </soap:Body>
</soap:Envelope>`);
    const add12 = wsdlRequests(CALCULATOR).services[0].ports[1].requests[0];
    expect(add12.body.raw).toContain('xmlns:soap="http://www.w3.org/2003/05/soap-envelope"');
  });

  it('follows derived, enumerated, optional, repeated, chosen and recursive types', () => {
    const place = wsdlRequests(CALCULATOR).services[0].ports[0].requests[1];
    expect(place.body.raw).toContain(`    <tns:Order version="?">
      <tns:id>0</tns:id>
      <tns:status>NEW</tns:status>
      <!--Optional:-->
      <tns:note>?</tns:note>
      <!--One or more:-->
      <tns:line>
        <tns:sku>?</tns:sku>
        <tns:placed>2026-01-01T00:00:00Z</tns:placed>
        <!--Optional:-->
        <tns:parent>
          <!--Line (recursive), left out-->
        </tns:parent>
      </tns:line>
      <!--A choice of 2; the first is shown-->
      <tns:card>?</tns:card>
    </tns:Order>`);
  });

  it('wraps rpc parts in the operation, fills the SOAP header, and reads imported schemas', async () => {
    const source = await loadWsdl('/wsdl/stock.wsdl', {
      read: async (location) => {
        if (location === '/wsdl/stock.wsdl') return RPC;
        if (location === resolveLocation('/wsdl/stock.wsdl', 'types.xsd')) return TYPES;
        throw new Error('not found');
      },
    });
    expect(Object.keys(source.documents)).toHaveLength(2);
    const { name, services } = wsdlRequests(source);
    expect(name).toBe('StockService');
    const [quote] = services[0].ports[0].requests;
    expect(services[0].ports[0].name).toBeUndefined();
    expect((quote.protocolConfig as SoapProtocolConfig).action).toBe('');
    expect(quote.body.raw).toBe(`<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns1="urn:stock:ops" xmlns:t="urn:types">
  <soap:Header>
    <t:Token>?</t:Token>
  </soap:Header>
  <soap:Body>
    <ns1:GetQuote>
      <symbol>?</symbol>
      <when>
        <t:day>2026-01-01</t:day>
      </when>
    </ns1:GetQuote>
  </soap:Body>
</soap:Envelope>`);
  });

  it('warns about an import it cannot read, and says what is wrong with a document that is no WSDL', async () => {
    const source = await loadWsdl('/wsdl/stock.wsdl', {
      read: async (location) => {
        if (location === '/wsdl/stock.wsdl') return RPC;
        throw new Error('not found');
      },
    });
    expect(source.warnings).toEqual([
      expect.stringMatching(/Couldn't read .*types\.xsd, which the WSDL imports: not found/),
    ]);
    // The types it needed are left as placeholders.
    expect(wsdlRequests(source).services[0].ports[0].requests[0].body.raw).toContain('<when>?</when>');

    expect(() => wsdlRequests('<html><body/></html>')).toThrow("This isn't a WSDL: its root element is <html>.");
    expect(() => wsdlRequests('<description xmlns="http://www.w3.org/ns/wsdl"/>')).toThrow(/WSDL 2\.0/);
    expect(() => wsdlRequests('<definitions')).toThrow(/The WSDL isn't valid XML/);
    await expect(loadWsdl('/nope.wsdl', { read: () => Promise.reject(new Error('ENOENT')) })).rejects.toThrow(
      "Couldn't read the WSDL /nope.wsdl: ENOENT",
    );
  });
});

describe('importWsdl', () => {
  it('stores a collection named after the service, with a folder per SOAP port', () => {
    const db = openDatabase(':memory:');
    const { workspace } = getOrCreateDefaultWorkspace(db);
    const result = importWsdl(db, workspace.id, CALCULATOR);
    expect(result).toMatchObject({ folderCount: 2, requestCount: 3, warnings: [expect.any(String)] });
    const collection = getCollectionTree(db, workspace.id).find((c) => c.id === result.collectionId)!;
    expect(collection.name).toBe('Calculator');
    expect(collection.children.map((f) => [f.name, f.requests.map((r) => r.name)])).toEqual([
      ['CalculatorSoap (SOAP 1.1)', ['Add', 'Place']],
      ['CalculatorSoap12 (SOAP 1.2)', ['Add']],
    ]);
    expect(getRequest(db, collection.children[0].requests[0].id)!.config.protocol).toBe('soap');
  });
});

describe('loadWsdl over HTTP', () => {
  let server: http.Server;
  let base: string;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/stock?wsdl')
        res.writeHead(200, { 'content-type': 'text/xml' }).end(RPC.replace('types.xsd', 'xsd/types.xsd'));
      else if (req.url === '/xsd/types.xsd') res.writeHead(200).end(TYPES);
      else res.writeHead(404, 'Not Found').end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  it('fetches the WSDL and the schemas it imports, relative to its URL', async () => {
    const source = await loadWsdl(`${base}/stock?wsdl`);
    expect(Object.keys(source.documents)).toEqual([`${base}/stock?wsdl`, `${base}/xsd/types.xsd`]);
    expect(source.warnings).toBeUndefined();
    await expect(loadWsdl(`${base}/missing?wsdl`)).rejects.toThrow(/Couldn't read the WSDL .*: 404 Not Found/);
  });

  it('makes requests that send the envelope as SOAP', async () => {
    const [quote] = wsdlRequests(await loadWsdl(`${base}/stock?wsdl`)).services[0].ports[0].requests;
    const response = await executeRequest({ ...quote, url: `${base}/soap-endpoint` });
    expect(response.status).toBe(404); // the request went out; the test server has no such endpoint
  });
});
