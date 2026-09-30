import { describe, expect, it } from 'vitest';
import { DEFAULT_ENGINE_PROFILE, type NativeExportDocument } from '../types';
import { adaptNativeExport } from './adaptNativeExport';
import { validateNativeExport } from './nativeImport';

const acme = { ...DEFAULT_ENGINE_PROFILE, productName: 'Acme', scriptNamespace: 'acme', exportFormat: 'acme-export' };
const base = { params: [], headers: [], body: { mode: 'none' as const }, auth: { type: 'none' as const } };

function otherDoc(): NativeExportDocument {
  return {
    format: 'other-export',
    version: 1,
    scope: 'workspace',
    exportedAt: '2026-09-30T00:00:00.000Z',
    secretsStripped: true,
    generator: { name: 'Other', version: '1.0.0', scriptNamespace: 'ot' },
    collections: [
      {
        category: 'api',
        name: 'API',
        folders: [
          {
            name: 'Nested',
            folders: [
              {
                name: 'Deeper',
                folders: [],
                items: [
                  {
                    type: 'request',
                    name: 'Deep',
                    config: { ...base, method: 'GET', url: '/deep', testScript: 'ot.test("deep", () => {});' },
                  },
                ],
              },
            ],
            items: [],
          },
        ],
        items: [
          {
            type: 'request',
            name: 'Both scripts',
            config: {
              ...base,
              method: 'GET',
              url: '/a',
              preRequestScript: 'ot.environment.set("x", 1);',
              testScript: 'ot.test("ok", () => ot.expect(ot.response.code).to.equal(200));',
            },
          },
          {
            type: 'request',
            name: 'No namespace use',
            config: { ...base, method: 'GET', url: '/b', testScript: 'console.log("ot.test")' },
          },
          { type: 'request', name: 'No scripts', config: { ...base, method: 'GET', url: '/c' } },
        ],
      },
      {
        category: 'websocket',
        name: 'Sockets',
        folders: [],
        items: [
          {
            type: 'websocket',
            name: 'Echo',
            url: 'wss://example.com',
            headers: [],
            subprotocols: [],
            auth: { type: 'none' },
            testScript: 'ot.test("echo", () => {});',
          },
        ],
      },
      {
        category: 'messaging',
        name: 'Brokers',
        folders: [],
        items: [
          {
            type: 'messaging',
            name: 'MQTT',
            protocol: 'mqtt',
            url: 'mqtt://localhost',
            headers: [],
            auth: { type: 'none' },
            settings: {},
            subscriptions: [],
            testScript: 'ot["test"]("m", () => {});',
          },
        ],
      },
      {
        category: 'mcp',
        name: 'Servers',
        folders: [],
        items: [{ type: 'mcp', name: 'Local', transport: 'stdio', command: 'ot.test', args: [], env: [], headers: [] }],
      },
    ],
    environments: [{ name: 'Local', variables: { script: 'ot.test()' } }],
  };
}

describe('adaptNativeExport', () => {
  it("rewrites every script to the profile's namespace and counts the ones that changed", () => {
    const original = otherDoc();
    const snapshot = structuredClone(original);
    const { doc, scriptsRewritten } = adaptNativeExport(original, acme);

    // Both scripts of the first request, the deep one, the WebSocket and the messaging one.
    expect(scriptsRewritten).toBe(5);
    expect(doc.generator).toEqual({ name: 'Other', version: '1.0.0', scriptNamespace: 'acme' });
    expect(doc.format).toBe('other-export');

    const [api, sockets, brokers, servers] = doc.collections;
    const [both, noUse, noScripts] = api.items;
    expect(both.type === 'request' && both.config).toMatchObject({
      preRequestScript: 'acme.environment.set("x", 1);',
      testScript: 'acme.test("ok", () => acme.expect(acme.response.code).to.equal(200));',
    });
    expect(noUse.type === 'request' && noUse.config.testScript).toBe('console.log("ot.test")');
    expect(noScripts).toEqual(original.collections[0].items[2]);
    expect(noScripts.type === 'request' && 'testScript' in noScripts.config).toBe(false);
    const deep = api.folders[0].folders[0].items[0];
    expect(deep.type === 'request' && deep.config.testScript).toBe('acme.test("deep", () => {});');
    expect(sockets.items[0].type === 'websocket' && sockets.items[0].testScript).toBe('acme.test("echo", () => {});');
    expect(brokers.items[0].type === 'messaging' && brokers.items[0].testScript).toBe('acme["test"]("m", () => {});');
    // Not scripts: left as they are.
    expect(servers).toEqual(original.collections[3]);
    expect(doc.environments).toEqual(original.environments);

    // Pure: the input is untouched.
    expect(original).toEqual(snapshot);
  });

  it('returns the document as is when there is nothing to adapt', () => {
    const same = { ...otherDoc(), generator: { name: 'Acme', scriptNamespace: 'acme' } };
    expect(adaptNativeExport(same, acme)).toEqual({ doc: same, scriptsRewritten: 0 });
    expect(adaptNativeExport(same, acme).doc).toBe(same);

    const { generator: _generator, ...withoutGenerator } = otherDoc();
    expect(adaptNativeExport(withoutGenerator, acme).doc).toBe(withoutGenerator);

    const invalid = { ...otherDoc(), generator: { name: 'Other', scriptNamespace: 'not valid' } };
    expect(adaptNativeExport(invalid, acme)).toEqual({ doc: invalid, scriptsRewritten: 0 });
  });

  it('updates the generator even when no script uses the namespace', () => {
    const doc = { ...otherDoc(), collections: [] };
    const adapted = adaptNativeExport(doc, acme);
    expect(adapted.scriptsRewritten).toBe(0);
    expect(adapted.doc.generator?.scriptNamespace).toBe('acme');
    expect(adapted.doc).not.toBe(doc);
  });

  it('adapts a validated file from another application the profile accepts', () => {
    const profile = { ...acme, acceptFormats: ['other-export'] };
    const validated = validateNativeExport(JSON.parse(JSON.stringify(otherDoc())), profile);
    const { doc, scriptsRewritten } = adaptNativeExport(validated, profile);
    expect(scriptsRewritten).toBe(5);
    expect(doc.generator?.scriptNamespace).toBe('acme');
  });
});
