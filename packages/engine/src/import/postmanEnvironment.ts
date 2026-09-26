import type Database from 'better-sqlite3';
import { createEnvironment, updateEnvironmentVariables } from '../storage/repository.js';
import type { Environment } from '../types.js';

interface PostmanEnvironmentValue {
  key?: string;
  value?: string;
  enabled?: boolean;
}
interface PostmanEnvironmentRoot {
  name?: string;
  values?: PostmanEnvironmentValue[];
}

export function importPostmanEnvironment(
  db: Database.Database,
  workspaceId: string,
  postmanJson: unknown,
): Environment {
  const root = postmanJson as PostmanEnvironmentRoot;
  const variables: Record<string, string> = {};
  for (const entry of root.values ?? []) {
    if (entry.enabled === false || !entry.key) continue;
    variables[entry.key] = entry.value ?? '';
  }

  const environment = createEnvironment(db, workspaceId, root.name ?? 'Imported Environment');
  updateEnvironmentVariables(db, environment.id, variables);
  return { ...environment, variables };
}
