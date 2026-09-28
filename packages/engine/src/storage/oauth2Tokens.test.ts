import { describe, expect, it } from 'vitest';
import { openDatabase } from './db';
import { getOrCreateDefaultWorkspace } from './repository';
import { clearOAuth2Tokens, sqliteOAuth2TokenStore } from './oauth2Tokens';

describe('sqliteOAuth2TokenStore', () => {
  it("keeps a workspace's tokens by key", () => {
    const db = openDatabase(':memory:');
    const { workspace } = getOrCreateDefaultWorkspace(db);
    const store = sqliteOAuth2TokenStore(db, workspace.id);
    const token = { accessToken: 'a', refreshToken: 'r', expiresAt: 5, obtainedAt: 1 };
    store.set('k1', token);
    store.set('k2', { ...token, accessToken: 'b' });
    store.set('k1', { ...token, accessToken: 'c' });
    expect(sqliteOAuth2TokenStore(db, workspace.id).get('k1')).toEqual({ ...token, accessToken: 'c' });
    expect(sqliteOAuth2TokenStore(db, 'another').get('k1')).toBeUndefined();
    store.delete('k1');
    expect(store.get('k1')).toBeUndefined();
    expect(clearOAuth2Tokens(db, workspace.id)).toBe(1);
    expect(store.get('k2')).toBeUndefined();
  });
});
