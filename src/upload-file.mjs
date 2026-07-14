import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';

export const MAX_UPLOAD_SIZE = 100 * 1024 * 1024;

const MIME_TYPES = {
  '.bmp': 'image/bmp',
  '.csv': 'text/csv',
  '.gif': 'image/gif',
  '.html': 'text/html',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.mov': 'video/quicktime',
  '.mp4': 'video/mp4',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.tar': 'application/x-tar',
  '.toml': 'text/toml',
  '.tsv': 'text/tab-separated-values',
  '.txt': 'text/plain',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.zip': 'application/zip',
};

const PUBLIC_IMAGE_TYPES = new Set([
  'image/bmp',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

export function getMimeType(path) {
  return MIME_TYPES[extname(path).toLowerCase()] || 'application/octet-stream';
}

export async function uploadLocalFile(client, path, options = {}) {
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile()) throw new Error(`Not a file: ${path}`);
  if (info.size > MAX_UPLOAD_SIZE) {
    throw new Error(`File exceeds the 100 MB upload limit: ${path}`);
  }

  const filename = basename(path);
  const contentType = getMimeType(path);
  const makePublic = options.makePublic === true;
  if (makePublic && !PUBLIC_IMAGE_TYPES.has(contentType)) {
    throw new Error('Public uploads are limited to PNG, JPEG, GIF, WebP, and BMP images');
  }

  const payload = await client.fileUpload(contentType, filename, info.size, { makePublic });
  if (!payload.success || !payload.uploadFile) throw new Error('Linear did not provide an upload URL');

  const upload = payload.uploadFile;
  const headers = { 'content-type': contentType };
  for (const header of upload.headers) headers[header.key] = header.value;
  const response = await (options.fetch || fetch)(upload.uploadUrl, {
    method: 'PUT',
    headers,
    body: await readFile(path),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`File upload failed: ${response.status} ${response.statusText}${detail ? ` - ${detail}` : ''}`);
  }

  return {
    assetUrl: upload.assetUrl,
    filename,
    size: info.size,
    contentType,
    public: makePublic,
  };
}
