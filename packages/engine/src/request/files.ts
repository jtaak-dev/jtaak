import { openAsBlob } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { mediaTypeFor } from './mediaTypes.js';

export { mediaTypeFor };

/** A file's name without its folder, from a Windows or POSIX path. */
export function fileNameOf(path: string): string {
  return basename(path.replace(/\\/g, '/'));
}

/**
 * A request body read from a file when it's sent: a Blob backed by the file,
 * so it's streamed rather than read into memory, and can be sent again (a
 * redirect, Digest's second try). Relative paths are from the working
 * directory. Throws a message naming the file when it can't be opened.
 */
export async function fileBody(path: string): Promise<Blob> {
  const fail = (reason: string): Error => new Error(`Couldn't read the body file "${path}": ${reason}`);
  let isFile: boolean;
  try {
    isFile = (await stat(path)).isFile();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw fail(code === 'ENOENT' ? 'no such file' : code === 'EACCES' ? 'permission denied' : (error as Error).message);
  }
  if (!isFile) throw fail('it is not a file');
  return openAsBlob(path, { type: mediaTypeFor(path) });
}
