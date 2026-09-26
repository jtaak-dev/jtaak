import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openDatabase } from './db';
import { DatabaseTooNewError, MIGRATIONS, migrate, schemaVersion, type Migration } from './migrations';

const LATEST = MIGRATIONS.at(-1)!.version;

function tempDbPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jtaak-migrate-')), 'jtaak.db');
}

function tableNames(db: Database.Database): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]
  ).map((r) => r.name);
}

describe('migrations', () => {
  it('numbers migrations 1, 2, 3… with no gaps or repeats', () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual(MIGRATIONS.map((_, i) => i + 1));
  });

  it('brings a new database to the latest version', () => {
    const db = openDatabase(':memory:');
    expect(schemaVersion(db)).toBe(LATEST);
    expect(tableNames(db)).toEqual(expect.arrayContaining(['workspaces', 'collections', 'requests', 'environments']));
  });

  it('marks an existing, unversioned database as migrated without losing data', () => {
    const filePath = tempDbPath();
    // A database from before versioning: current tables, user_version 0.
    const legacy = openDatabase(filePath);
    legacy.prepare("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'Legacy', 0)").run();
    legacy.pragma('user_version = 0');
    legacy.close();

    const db = openDatabase(filePath);
    expect(schemaVersion(db)).toBe(LATEST);
    expect(db.prepare("SELECT name FROM workspaces WHERE id = 'w1'").get()).toEqual({ name: 'Legacy' });
    db.close();
  });

  it('applies only the migrations a database has not had yet, in order', () => {
    const applied: number[] = [];
    const migrations: Migration[] = [1, 2, 3].map((version) => ({
      version,
      name: `m${version}`,
      up: () => void applied.push(version),
    }));
    const db = new Database(':memory:');
    db.pragma('user_version = 1');

    migrate(db, migrations);
    expect(applied).toEqual([2, 3]);
    expect(schemaVersion(db)).toBe(3);

    migrate(db, migrations);
    expect(applied).toEqual([2, 3]);
  });

  it('rolls back a failing migration and leaves the version unchanged', () => {
    const db = new Database(':memory:');
    const migrations: Migration[] = [
      { version: 1, name: 'ok', up: (d) => d.exec('CREATE TABLE a (x)') },
      {
        version: 2,
        name: 'fails halfway',
        up: (d) => {
          d.exec('CREATE TABLE b (x)');
          throw new Error('boom');
        },
      },
    ];

    expect(() => migrate(db, migrations)).toThrow('boom');
    expect(schemaVersion(db)).toBe(1);
    expect(tableNames(db)).toEqual(['a']);
  });

  it('refuses a database written by a newer version of the app', () => {
    const filePath = tempDbPath();
    const db = openDatabase(filePath);
    db.pragma(`user_version = ${LATEST + 1}`);
    db.close();

    expect(() => openDatabase(filePath)).toThrow(DatabaseTooNewError);
    expect(() => openDatabase(filePath)).toThrow(/newer version of the app/);
  });
});
