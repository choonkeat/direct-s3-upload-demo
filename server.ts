import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, dirname, extname, resolve } from 'node:path';
import Busboy from 'busboy';
import { config, mode } from './lib/config.js';
import { presignPut, presignPost } from './lib/presign.js';
import { presignPutMock, presignPostMock } from './lib/mock-presign.js';
import type {
  PresignRequest,
  PresignResponse,
  ListFilesResponse,
  UploadedFile,
} from './lib/types.js';

const PUBLIC_DIR = resolve(import.meta.dirname ?? '.', 'public');
const MOCK_UPLOADS_DIR = resolve(import.meta.dirname ?? '.', 'mock_uploads');
const MOCK_META_FILE = resolve(MOCK_UPLOADS_DIR, '.meta.json');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
};

function s3ErrorXml(code: string, message: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Error><Code>${code}</Code><Message>${message}</Message></Error>`;
}

function sendS3Error(res: ServerResponse, status: number, code: string, message: string): void {
  res.writeHead(status, {
    'Content-Type': 'application/xml',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(s3ErrorXml(code, message));
}

interface PolicyDoc {
  expiration?: string;
  conditions: Array<unknown>;
}

function validatePolicy(
  policy: PolicyDoc,
  upload: { key: string; contentType: string; size: number },
): { ok: true } | { ok: false; code: string; message: string } {
  if (policy.expiration && new Date(policy.expiration).getTime() < Date.now()) {
    return { ok: false, code: 'PolicyExpired', message: 'Policy has expired' };
  }
  for (const cond of policy.conditions) {
    if (Array.isArray(cond)) {
      const [op, field, ...rest] = cond as [string, string, ...unknown[]];
      if (op === 'content-length-range') {
        const [min, max] = cond.slice(1) as [number, number];
        if (upload.size < min || upload.size > max) {
          return {
            ok: false,
            code: 'EntityTooLarge',
            message: `File size ${upload.size} not within allowed range [${min}, ${max}]`,
          };
        }
        continue;
      }
      if (op === 'starts-with') {
        const prefix = rest[0] as string;
        let actual: string;
        if (field === '$Content-Type') actual = upload.contentType;
        else if (field === '$key') actual = upload.key;
        else continue;
        if (!actual.startsWith(prefix)) {
          return {
            ok: false,
            code: 'AccessDenied',
            message: `${field} value "${actual}" does not start with "${prefix}"`,
          };
        }
        continue;
      }
      if (op === 'eq') {
        const expected = rest[0] as string;
        let actual: string;
        if (field === '$Content-Type') actual = upload.contentType;
        else if (field === '$key') actual = upload.key;
        else continue;
        if (actual !== expected) {
          return {
            ok: false,
            code: 'AccessDenied',
            message: `${field} value "${actual}" does not equal "${expected}"`,
          };
        }
        continue;
      }
    } else if (cond && typeof cond === 'object') {
      const entries = Object.entries(cond as Record<string, string>);
      for (const [field, expected] of entries) {
        let actual: string | undefined;
        if (field === 'Content-Type' || field === 'content-type') actual = upload.contentType;
        else if (field === 'key') actual = upload.key;
        else continue;
        if (actual !== expected) {
          return {
            ok: false,
            code: 'AccessDenied',
            message: `${field} value "${actual}" does not equal "${expected}"`,
          };
        }
      }
    }
  }
  return { ok: true };
}

function sanitizeFilename(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? 'file';
  return base.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200) || 'file';
}

function makeKey(filename: string): string {
  const safe = sanitizeFilename(filename);
  return `${config.keyPrefix}${randomUUID()}/${safe}`;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const buf = await readBody(req);
  return JSON.parse(buf.toString('utf8')) as T;
}

async function loadMockMeta(): Promise<UploadedFile[]> {
  if (!existsSync(MOCK_META_FILE)) return [];
  try {
    const data = await readFile(MOCK_META_FILE, 'utf8');
    return JSON.parse(data) as UploadedFile[];
  } catch {
    return [];
  }
}

async function saveMockMeta(meta: UploadedFile[]): Promise<void> {
  await mkdir(dirname(MOCK_META_FILE), { recursive: true });
  await writeFile(MOCK_META_FILE, JSON.stringify(meta, null, 2));
}

async function appendMockFile(record: UploadedFile): Promise<void> {
  const meta = await loadMockMeta();
  meta.unshift(record);
  await saveMockMeta(meta);
}

async function serveStatic(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  const filePath = resolve(PUBLIC_DIR, '.' + path);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return true;
  }
  if (!existsSync(filePath)) return false;
  const stats = await stat(filePath);
  if (stats.isDirectory()) return false;
  const ext = extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  res.end(await readFile(filePath));
  return true;
}

async function handleMockUpload(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<void> {
  // POST: multipart, key is in form field. URL is .../__mock_s3__/{bucket}/
  // PUT:  raw body, key is in URL path.   URL is .../__mock_s3__/{bucket}/{key...}
  const prefix = `/__mock_s3__/${config.bucket}`;
  if (!pathname.startsWith(prefix)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const remainder = pathname.slice(prefix.length); // "" or "/key/..."

  if (req.method === 'PUT') {
    if (remainder.length <= 1) {
      res.writeHead(400);
      res.end('PUT requires a key in the path');
      return;
    }
    const key = decodeURIComponent(remainder.slice(1));
    const target = join(MOCK_UPLOADS_DIR, key);
    await mkdir(dirname(target), { recursive: true });
    const body = await readBody(req);
    await writeFile(target, body);
    await appendMockFile({
      key,
      size: body.length,
      contentType: (req.headers['content-type'] as string) ?? 'application/octet-stream',
      uploadedAt: new Date().toISOString(),
      via: 'PUT',
    });
    res.writeHead(200, {
      ETag: `"${randomUUID().replace(/-/g, '')}"`,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'ETag',
    });
    res.end();
    return;
  }

  if (req.method === 'POST') {
    if (remainder !== '/' && remainder !== '') {
      res.writeHead(400);
      res.end('POST goes to bucket root, key is a form field');
      return;
    }
    let key = '';
    let contentType = 'application/octet-stream';
    let policyB64 = '';
    let fileBuf: Buffer | null = null;

    const bb = Busboy({ headers: req.headers });
    bb.on('field', (name, value) => {
      if (name === 'key') key = value;
      else if (name === 'Content-Type' || name === 'content-type') contentType = value;
      else if (name === 'policy') policyB64 = value;
    });
    bb.on('file', (_name, file, info) => {
      const chunks: Buffer[] = [];
      file.on('data', (c) => chunks.push(c));
      file.on('end', () => {
        fileBuf = Buffer.concat(chunks);
        if (!contentType || contentType === 'application/octet-stream') {
          contentType = info.mimeType || contentType;
        }
      });
    });

    await new Promise<void>((done, fail) => {
      bb.on('finish', () => done());
      bb.on('error', fail);
      req.pipe(bb);
    });

    if (!key || !fileBuf) {
      sendS3Error(res, 400, 'MalformedPOSTRequest', 'Missing key or file field');
      return;
    }

    if (policyB64) {
      try {
        const policy = JSON.parse(
          Buffer.from(policyB64, 'base64').toString('utf8'),
        ) as PolicyDoc;
        const verdict = validatePolicy(policy, {
          key,
          contentType,
          size: (fileBuf as Buffer).length,
        });
        if (!verdict.ok) {
          sendS3Error(res, 403, verdict.code, verdict.message);
          return;
        }
      } catch (err) {
        sendS3Error(res, 400, 'MalformedPolicy', `Could not parse policy: ${(err as Error).message}`);
        return;
      }
    }
    const target = join(MOCK_UPLOADS_DIR, key);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, fileBuf);
    await appendMockFile({
      key,
      size: (fileBuf as Buffer).length,
      contentType,
      uploadedAt: new Date().toISOString(),
      via: 'POST',
    });
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
    res.end();
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'PUT, POST, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    });
    res.end();
    return;
  }

  res.writeHead(405);
  res.end('Method not allowed');
}

async function listMockFiles(): Promise<UploadedFile[]> {
  return loadMockMeta();
}

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<void> {
  if (req.method === 'GET' && pathname === '/api/config') {
    json(res, 200, {
      mode,
      bucket: config.bucket,
      region: config.region,
      keyPrefix: config.keyPrefix,
      maxUploadBytes: config.maxUploadBytes,
      allowedContentTypePrefix: config.allowedContentTypePrefix,
      presignExpiresIn: config.presignExpiresIn,
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/presign-put') {
    const body = await readJson<PresignRequest>(req);
    const key = makeKey(body.filename);
    const result: PresignResponse =
      mode === 'real'
        ? await presignPut(body, key)
        : presignPutMock(body, key);
    json(res, 200, result);
    return;
  }

  if (req.method === 'POST' && pathname === '/api/presign-post') {
    const body = await readJson<PresignRequest>(req);
    const key = makeKey(body.filename);
    const result: PresignResponse =
      mode === 'real'
        ? await presignPost(body, key)
        : presignPostMock(body, key);
    json(res, 200, result);
    return;
  }

  if (req.method === 'GET' && pathname === '/api/files') {
    if (mode === 'mock') {
      const out: ListFilesResponse = { mode, files: await listMockFiles() };
      json(res, 200, out);
      return;
    }
    json(res, 200, {
      mode,
      files: [],
      note: 'File listing is only implemented for mock mode. Check the S3 console for real uploads.',
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
}

const PAGE_ROUTES: Record<string, string> = {
  '/': 'index.html',
  '/put': 'put.html',
  '/post': 'post.html',
};

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const pathname = url.pathname;

  try {
    if (pathname.startsWith('/__mock_s3__/')) {
      await handleMockUpload(req, res, pathname);
      return;
    }
    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname);
      return;
    }
    if (PAGE_ROUTES[pathname]) {
      const filePath = resolve(PUBLIC_DIR, PAGE_ROUTES[pathname]);
      if (existsSync(filePath)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(await readFile(filePath));
        return;
      }
    }
    if (await serveStatic(req, res, pathname)) return;
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (err) {
    console.error('Request failed:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    } else {
      res.end();
    }
  }
}

async function main(): Promise<void> {
  await mkdir(MOCK_UPLOADS_DIR, { recursive: true });
  const server = createServer(handle);
  server.listen(config.port, () => {
    const banner = [
      '',
      `  s3-fileupload demo`,
      `  mode:    ${mode === 'real' ? `REAL AWS — bucket=${config.bucket} region=${config.region}` : 'MOCK (no AWS creds set)'}`,
      `  url:     http://localhost:${config.port}/`,
      `  prefix:  ${config.keyPrefix}`,
      `  max:     ${(config.maxUploadBytes / 1024 / 1024).toFixed(1)} MB`,
      `  c-type:  ${config.allowedContentTypePrefix ?? '(any)'}`,
      `  expiry:  ${config.presignExpiresIn}s`,
      '',
    ].join('\n');
    console.log(banner);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
