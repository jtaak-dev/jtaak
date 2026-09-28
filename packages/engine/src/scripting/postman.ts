// What of Postman's script API (pm.*) the sandbox has (sandbox.ts's PRELUDE
// defines `pm`), so an importer can say which calls in a Postman script
// won't work here.

/** The pm members scripts can use, and for those that are objects, their members. */
export const SUPPORTED_PM_API: Record<string, readonly string[] | true> = {
  test: true,
  expect: true,
  environment: ['get', 'has', 'set', 'unset', 'toObject', 'replaceIn'],
  variables: ['get', 'has', 'set', 'unset', 'toObject', 'replaceIn'],
  collectionVariables: ['get', 'has', 'set', 'unset', 'toObject', 'replaceIn'],
  globals: ['get', 'has', 'set', 'unset', 'toObject', 'replaceIn'],
  request: ['url', 'method', 'headers', 'name'],
  response: ['code', 'status', 'headers', 'responseTime', 'responseSize', 'json', 'text', 'to'],
  cookies: ['get', 'has', 'toObject'],
  info: ['requestName'],
};

/**
 * The Postman calls in a script that the sandbox doesn't have, each once,
 * in order: `pm` members it lacks (`pm.sendRequest`, `pm.iterationData`…),
 * and the old `postman.*` and `tests[…]` forms.
 */
export function unsupportedPostmanCalls(script: string): string[] {
  const found = new Set<string>();
  for (const match of script.matchAll(/\bpm\.([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?/g)) {
    const [, member, sub] = match;
    const supported = SUPPORTED_PM_API[member];
    if (supported === undefined) found.add(`pm.${member}`);
    else if (supported !== true && sub !== undefined && !supported.includes(sub)) found.add(`pm.${member}.${sub}`);
  }
  for (const match of script.matchAll(/\bpostman\.([A-Za-z_$][\w$]*)/g)) found.add(`postman.${match[1]}`);
  if (/\btests\s*\[/.test(script)) found.add('tests[…]');
  return [...found];
}
