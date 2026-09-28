import type Database from 'better-sqlite3';
import type { OAuth2TokenStore } from '../request/oauth2.js';
import type { OAuth2Token } from '../types.js';

/**
 * A workspace's OAuth 2.0 tokens, kept in SQLite (migration 6) so they last
 * between sends and restarts, and stay out of saved requests and exports.
 */
export function sqliteOAuth2TokenStore(db: Database.Database, workspaceId: string): OAuth2TokenStore {
  return {
    get(key) {
      const row = db
        .prepare('SELECT token_json FROM oauth2_tokens WHERE workspace_id = ? AND key = ?')
        .get(workspaceId, key) as { token_json: string } | undefined;
      return row ? (JSON.parse(row.token_json) as OAuth2Token) : undefined;
    },
    set(key, token) {
      db.prepare(
        'INSERT OR REPLACE INTO oauth2_tokens (workspace_id, key, token_json, updated_at) VALUES (?, ?, ?, ?)',
      ).run(workspaceId, key, JSON.stringify(token), Date.now());
    },
    delete(key) {
      db.prepare('DELETE FROM oauth2_tokens WHERE workspace_id = ? AND key = ?').run(workspaceId, key);
    },
  };
}

/** Forgets every OAuth 2.0 token of a workspace; returns how many went. */
export function clearOAuth2Tokens(db: Database.Database, workspaceId: string): number {
  return db.prepare('DELETE FROM oauth2_tokens WHERE workspace_id = ?').run(workspaceId).changes;
}
