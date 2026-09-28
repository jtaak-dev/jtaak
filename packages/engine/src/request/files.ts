import { openAsBlob } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';

// Media types for the extensions a request body is most often read from. A
// request's own Content-Type header always wins over these.
const MEDIA_TYPES: Record<string, string> = {
  '.avif': 'image/avif',
  '.bin': 'application/octet-stream',
  '.bmp': 'image/bmp',
  '.csv': 'text/csv',
  '.gif': 'image/gif',
  '.gz': 'application/gzip',
  '.htm': 'text/html',
  '.html': 'text/html',
  '.ico': 'image/vnd.microsoft.icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.proto': 'text/plain',
  '.svg': 'image/svg+xml',
  '.tar': 'application/x-tar',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.txt': 'text/plain',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.zip': 'application/zip',
};

/** The media type for a file, from its extension; `application/octet-stream` when it isn't known. */
export function mediaTypeFor(path: string): string {
  return MEDIA_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

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
