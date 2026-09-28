import type { RunnableRequest } from './collectionRunner.js';
import type { NativeExportDocument, NativeExportFolder, Protocol } from '../types.js';

/** A request from an export file, with where it sits: its collection, then its folders. */
export interface ExportedRequest extends RunnableRequest {
  path: string[];
}

export interface ExportRequestSelection {
  /** Only this collection or folder, by name or by path (`Collection/Folder`). */
  folder?: string;
}

/** What runCollection sends: requests answered by one HTTP exchange. The rest go through openStream or a gRPC call. */
const RUNNABLE: readonly Protocol[] = ['http', 'graphql', 'soap'];

/**
 * The requests in an export file's API collections, in the order they
 * appear (a folder's requests, then its subfolders', as in the app), for
 * runCollection. `skipped` lists those it can't run: gRPC, SSE, WebSocket
 * and other streaming requests. Throws when `folder` matches nothing.
 */
export function runnableRequestsFromExport(
  doc: NativeExportDocument,
  selection: ExportRequestSelection = {},
): { requests: ExportedRequest[]; skipped: ExportedRequest[] } {
  const requests: ExportedRequest[] = [];
  const skipped: ExportedRequest[] = [];
  const wanted = selection.folder
    ?.split('/')
    .map((part) => part.trim())
    .filter(Boolean);
  let matched = !wanted;

  const walk = (folder: NativeExportFolder, path: string[], inside: boolean) => {
    const here = [...path, folder.name];
    // A folder matches by its full path, or by its own name alone.
    const matches =
      !!wanted &&
      ((wanted.length === here.length && wanted.every((part, i) => part === here[i])) ||
        (wanted.length === 1 && wanted[0] === folder.name));
    const take = inside || !wanted || matches;
    if (matches) matched = true;
    if (take) {
      folder.items.forEach((item, index) => {
        if (item.type !== 'request') return;
        const request: ExportedRequest = {
          id: `${here.join('/')}#${index}`,
          name: item.name,
          path: here,
          config: { ...item.config, id: `${here.join('/')}#${index}`, name: item.name },
        };
        (RUNNABLE.includes(item.config.protocol ?? 'http') ? requests : skipped).push(request);
      });
    }
    for (const child of folder.folders) walk(child, here, take);
  };
  for (const collection of doc.collections) {
    if (collection.category === 'api') walk(collection, [], false);
  }
  if (!matched) throw new Error(`No collection or folder named "${selection.folder}" in the file.`);
  return { requests, skipped };
}
