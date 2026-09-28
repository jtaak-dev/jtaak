import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../storage/db';
import { createWorkspace } from '../storage/repository';
import { exportNative, serializeNativeExport } from '../export/nativeExport';
import { importNative, previewNativeImport, validateNativeExport } from './nativeImport';

// The shareable sample in this package's samples/ folder — kept importable (and
// byte-for-byte what the exporter would write) as the format evolves.
const SAMPLE_PATH = fileURLToPath(new URL('../../samples/jtaak-sample-workspace.jt', import.meta.url));

describe('samples/jtaak-sample-workspace.jt', () => {
  const text = fs.readFileSync(SAMPLE_PATH, 'utf8');

  it('is a valid workspace export covering every category, request protocol and messaging protocol', () => {
    const doc = validateNativeExport(JSON.parse(text));
    expect(doc.scope).toBe('workspace');
    expect(new Set(doc.collections.map((c) => c.category))).toEqual(new Set(['api', 'websocket', 'mcp', 'messaging']));

    const protocols = new Set<string>();
    const messaging = new Set<string>();
    const walk = (f: (typeof doc.collections)[number]['folders'][number]) => {
      for (const item of f.items) {
        if (item.type === 'request') protocols.add(item.config.protocol ?? 'http');
        if (item.type === 'messaging') messaging.add(item.protocol);
      }
      f.folders.forEach(walk);
    };
    doc.collections.forEach(walk);
    expect(protocols).toEqual(new Set(['http', 'graphql', 'sse', 'grpc', 'soap']));
    expect(messaging).toEqual(new Set(['mqtt', 'kafka', 'socketio', 'amqp', 'nats']));

    const preview = previewNativeImport(doc);
    expect(preview.environments.length).toBeGreaterThan(0);
    expect(preview.scriptRequestCount).toBeGreaterThan(0);
    // A binary body and a form-data file, both sending sample-upload.txt, which is next to it.
    expect(preview.localFileRequestCount).toBe(2);
    expect(fs.existsSync(fileURLToPath(new URL('../../samples/sample-upload.txt', import.meta.url)))).toBe(true);
    expect(text).toContain('"examples": [');
  });

  it('imports cleanly and re-exports to the same file', () => {
    const db = openDatabase(':memory:');
    const workspaceId = createWorkspace(db, 'Sample').id;
    importNative(db, workspaceId, validateNativeExport(JSON.parse(text)), {
      includeScripts: true,
      includeEnvironments: true,
    });

    const reExported = exportNative(
      db,
      workspaceId,
      { scope: 'workspace' },
      { includeSecrets: true, environmentIds: [] },
    );
    const original = JSON.parse(text) as { exportedAt: string };
    // Environments come back sorted by name; the sample lists them that way too.
    expect(serializeNativeExport({ ...reExported, exportedAt: original.exportedAt })).toBe(text);
  });
});
