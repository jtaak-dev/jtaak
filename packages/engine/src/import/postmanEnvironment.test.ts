import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../storage/db';
import { getOrCreateDefaultWorkspace, listEnvironments } from '../storage/repository';
import { importPostmanEnvironment } from './postmanEnvironment';

function freshDb(): Database.Database {
  return openDatabase(':memory:');
}

describe('importPostmanEnvironment', () => {
  it('creates an environment with enabled variables only', () => {
    const db = freshDb();
    const { workspace } = getOrCreateDefaultWorkspace(db);

    const environment = importPostmanEnvironment(db, workspace.id, {
      name: 'Staging',
      values: [
        { key: 'baseUrl', value: 'https://staging.example.com', enabled: true },
        { key: 'token', value: 'secret', enabled: true },
        { key: 'unused', value: 'x', enabled: false },
      ],
    });

    expect(environment.name).toBe('Staging');
    expect(environment.variables).toEqual({ baseUrl: 'https://staging.example.com', token: 'secret' });
    expect(listEnvironments(db, workspace.id).map((e) => e.name)).toEqual(['Staging']);
  });

  it('treats a missing `enabled` field as enabled', () => {
    const db = freshDb();
    const { workspace } = getOrCreateDefaultWorkspace(db);
    const environment = importPostmanEnvironment(db, workspace.id, {
      name: 'Prod',
      values: [{ key: 'x', value: 'y' }],
    });
    expect(environment.variables).toEqual({ x: 'y' });
  });
});
