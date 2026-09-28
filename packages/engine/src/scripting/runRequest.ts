import { executeRequest } from '../request/executor.js';
import { resolveDeep } from '../variables/resolver.js';
import { diffEnvironment } from '../variables/environmentUpdates.js';
import { runScript, type ScriptConsoleEntry } from './sandbox.js';
import { DEFAULT_ENGINE_PROFILE, type EngineProfile } from '../types.js';
import type { RequestConfig, RequestRunResult, ScriptLogEntry, VariableScope } from '../types.js';
import type { CookieJar } from '../request/cookieJar.js';
import { getOAuth2Token, MemoryOAuth2TokenStore, type OAuth2TokenStore } from '../request/oauth2.js';
import type { ScriptCookie } from './sandbox.js';

export interface RunRequestOptions {
  /** Cookies kept between requests (see `ExecuteOptions.cookieJar`); scripts read the URL's cookies as `<namespace>.cookies`. */
  cookieJar?: CookieJar;
  /** Where OAuth 2.0 tokens are kept (request/oauth2.ts). Without it, a token is got for this request only. */
  oauth2Tokens?: OAuth2TokenStore;
  /** Opens the provider's sign-in page, for the authorization code grant when there's no valid token. */
  openBrowser?: (url: string) => void | Promise<void>;
}

/** The jar's cookies for a request's URL, as scripts see them. */
function scriptCookies(jar: CookieJar | undefined, url: string): ScriptCookie[] {
  if (!jar) return [];
  return jar.cookiesFor(url).map(({ name, value, domain, path, expiresAt, secure, httpOnly }) => ({
    name,
    value,
    domain,
    path,
    ...(expiresAt !== undefined && { expires: new Date(expiresAt).toISOString() }),
    secure,
    httpOnly,
  }));
}

function tagPhase(entries: ScriptConsoleEntry[], phase: ScriptLogEntry['phase']): ScriptLogEntry[] {
  return entries.map((entry) => ({ ...entry, phase }));
}

/**
 * Runs a request through the full engine pipeline: pre-request script (which
 * may set variables consumed by this same request) → variable resolution →
 * send → test script against the response. This is the entry point both a
 * single "Send" action and the collection runner use, so the two never
 * drift in what "running a request" actually means.
 *
 * Scripts see two sets of values. `<namespace>.variables` starts as the
 * environment's values, and what scripts set there lasts only for this
 * request. `<namespace>.environment` is the environment itself: what scripts
 * set there is used by this request too, and comes back as
 * `environmentUpdates` for the caller to keep (say, a token a login
 * request's test script read from the response).
 */
export async function runRequestWithScripts(
  config: RequestConfig,
  scopes: VariableScope,
  profile: EngineProfile = DEFAULT_ENGINE_PROFILE,
  options: RunRequestOptions = {},
): Promise<RequestRunResult> {
  const { cookieJar } = options;
  // A mutable working copy: a pre-request script can set a variable (e.g. a
  // timestamp or a token) that this same request's URL/headers/body then
  // resolve against, before anything is sent over the network.
  const variables = { ...scopes.environment };
  const environment = { ...scopes.environment };
  const scriptLogs: ScriptLogEntry[] = [];
  // Only when something changed, so results without scripts look as before.
  const withUpdates = (result: RequestRunResult): RequestRunResult => {
    const updates = diffEnvironment(scopes.environment, environment);
    return Object.keys(updates).length > 0 ? { ...result, environmentUpdates: updates } : result;
  };

  if (config.preRequestScript) {
    try {
      const preRequestRun = await runScript(
        config.preRequestScript,
        {
          request: config,
          variables,
          environment,
          cookies: scriptCookies(cookieJar, resolveDeep(config.url, { ...scopes, environment: variables })),
        },
        undefined,
        profile,
      );
      scriptLogs.push(...tagPhase(preRequestRun.logs, 'pre-request'));
    } catch (error) {
      return { testResults: [], scriptLogs, preRequestError: (error as Error).message };
    }
  }

  let resolvedConfig = resolveDeep(config, { ...scopes, environment: variables });

  // OAuth 2.0: a token of the request's own is sent as it is; otherwise the
  // store's, refreshed or new as needed (after variables, which the settings
  // may use).
  const oauth2 = resolvedConfig.auth.type === 'oauth2' ? resolvedConfig.auth.oauth2 : undefined;
  if (oauth2 && !oauth2.token?.accessToken) {
    try {
      const { token } = await getOAuth2Token(oauth2, {
        store: options.oauth2Tokens ?? new MemoryOAuth2TokenStore(),
        openBrowser: options.openBrowser,
        productName: profile.productName,
        verifyTls: resolvedConfig.verifyTls,
      });
      resolvedConfig = { ...resolvedConfig, auth: { ...resolvedConfig.auth, oauth2: { ...oauth2, token } } };
    } catch (error) {
      return withUpdates({ testResults: [], scriptLogs, sendError: (error as Error).message });
    }
  }

  let response;
  try {
    response = await executeRequest(resolvedConfig, { cookieJar });
  } catch (error) {
    return withUpdates({ testResults: [], scriptLogs, sendError: (error as Error).message });
  }

  let testResults: RequestRunResult['testResults'] = [];
  if (config.testScript) {
    try {
      const testRun = await runScript(
        config.testScript,
        {
          request: resolvedConfig,
          response,
          variables,
          environment,
          cookies: scriptCookies(cookieJar, resolvedConfig.url),
        },
        undefined,
        profile,
      );
      testResults = testRun.results;
      scriptLogs.push(...tagPhase(testRun.logs, 'test'));
    } catch (error) {
      return withUpdates({
        response,
        testResults: [],
        scriptLogs,
        sendError: `test script error: ${(error as Error).message}`,
      });
    }
  }

  return withUpdates({ response, testResults, scriptLogs });
}
