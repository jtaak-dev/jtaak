// Browser-safe (no Node built-ins): code snippets use it as well as the executor.
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
  const extension = /\.[^./\\]+$/.exec(path)?.[0].toLowerCase() ?? '';
  return MEDIA_TYPES[extension] ?? 'application/octet-stream';
}
