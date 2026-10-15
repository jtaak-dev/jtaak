import { describe, expect, it } from 'vitest';
import { openDatabase } from './db';
import { createWorkspace, deleteWorkspace, getOrCreateDefaultWorkspace } from './repository';
import { deleteApiSpec, findApiSpec, getApiSpec, listApiSpecs, listWorkspaceApiSpecs, saveApiSpec } from './specs';

describe('API specs', () => {
  it('are kept per workspace, one per kind and location, and deleted with it', () => {
    const db = openDatabase(':memory:');
    const { workspace } = getOrCreateDefaultWorkspace(db);
    const other = createWorkspace(db, 'Other');
    const graphql = saveApiSpec(db, {
      workspaceId: workspace.id,
      kind: 'graphql',
      name: 'Schema',
      location: 'https://api.test/graphql',
      source: '{"types":[]}',
    });
    const again = saveApiSpec(db, {
      workspaceId: workspace.id,
      kind: 'graphql',
      name: 'Schema',
      location: ' https://api.test/graphql ',
      source: '{"types":[1]}',
    });
    expect(again.id).toBe(graphql.id);
    expect(getApiSpec(db, graphql.id)?.source).toBe('{"types":[1]}');
    expect(findApiSpec(db, workspace.id, 'graphql', 'https://api.test/graphql')?.id).toBe(graphql.id);
    const pasted = saveApiSpec(db, { workspaceId: workspace.id, kind: 'openapi', name: 'Pasted', source: '{}' });
    const second = saveApiSpec(db, { workspaceId: workspace.id, kind: 'openapi', name: 'Pasted', source: '{}' });
    expect(second.id).not.toBe(pasted.id);
    saveApiSpec(db, { workspaceId: other.id, kind: 'wsdl', name: 'W', source: '<x/>' });

    expect(
      listApiSpecs(db, workspace.id)
        .map((s) => s.kind)
        .sort(),
    ).toEqual(['graphql', 'openapi', 'openapi']);
    expect(listApiSpecs(db, workspace.id)[0]).not.toHaveProperty('source');
    expect(listWorkspaceApiSpecs(db, workspace.id).get(graphql.id)?.source).toBe('{"types":[1]}');
    deleteApiSpec(db, pasted.id);
    expect(getApiSpec(db, pasted.id)).toBeUndefined();
    deleteWorkspace(db, other.id);
    expect(listApiSpecs(db, other.id)).toEqual([]);
  });
});
