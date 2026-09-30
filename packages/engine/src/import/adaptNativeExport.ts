import { isScriptNamespace, rewriteScriptNamespace } from '../scripting/scriptNamespace.js';
import type { EngineProfile, NativeExportDocument, NativeExportFolder, NativeExportItem } from '../types.js';

/**
 * Adapts a validated export written by another application built on the
 * engine to this one: when its `generator.scriptNamespace` differs from the
 * profile's, returns a copy whose scripts call the profile's namespace
 * instead (see `rewriteScriptNamespace`), with the generator's
 * `scriptNamespace` updated to match. `scriptsRewritten` counts the scripts
 * that changed. A file without a (valid) generator, or with the profile's own
 * namespace, comes back as it is. Pure: nothing is stored.
 */
export function adaptNativeExport(
  doc: NativeExportDocument,
  profile: EngineProfile,
): { doc: NativeExportDocument; scriptsRewritten: number } {
  const from = doc.generator?.scriptNamespace;
  const to = profile.scriptNamespace;
  if (!doc.generator || !from || from === to || !isScriptNamespace(from) || !isScriptNamespace(to)) {
    return { doc, scriptsRewritten: 0 };
  }

  let scriptsRewritten = 0;
  const rewrite = (script: string): string => {
    const result = rewriteScriptNamespace(script, from, to);
    if (result.count > 0) scriptsRewritten++;
    return result.source;
  };

  const adaptItem = (item: NativeExportItem): NativeExportItem => {
    if (item.type === 'request') {
      const { preRequestScript, testScript } = item.config;
      if (preRequestScript === undefined && testScript === undefined) return item;
      return {
        ...item,
        config: {
          ...item.config,
          ...(preRequestScript !== undefined && { preRequestScript: rewrite(preRequestScript) }),
          ...(testScript !== undefined && { testScript: rewrite(testScript) }),
        },
      };
    }
    if ((item.type === 'websocket' || item.type === 'messaging') && item.testScript !== undefined) {
      return { ...item, testScript: rewrite(item.testScript) };
    }
    return item;
  };

  const adaptFolder = <F extends NativeExportFolder>(folder: F): F => ({
    ...folder,
    folders: folder.folders.map(adaptFolder),
    items: folder.items.map(adaptItem),
  });

  return {
    doc: {
      ...doc,
      generator: { ...doc.generator, scriptNamespace: to },
      collections: doc.collections.map(adaptFolder),
    },
    scriptsRewritten,
  };
}
