import type {
  PresignRequest,
  PresignResponse,
  PresignedPutResponse,
  PresignedPostResponse,
  ListFilesResponse,
} from '../lib/types.js';

type Mode = 'PUT' | 'POST';

interface UI {
  dropzone: HTMLElement;
  fileInput: HTMLInputElement;
  fileList: HTMLUListElement;
  uploaded: HTMLUListElement;
  raw: HTMLPreElement;
  modeInfo: HTMLElement;
}

function $(sel: string): HTMLElement {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`Missing element: ${sel}`);
  return el as HTMLElement;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

async function getPresign(
  mode: Mode,
  req: PresignRequest,
): Promise<PresignResponse> {
  const path = mode === 'PUT' ? '/api/presign-put' : '/api/presign-post';
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!r.ok) throw new Error(`Presign failed: ${r.status} ${await r.text()}`);
  return (await r.json()) as PresignResponse;
}

function parseS3ErrorBody(body: string): { code: string; message: string } | null {
  // Matches AWS-style <Error><Code>...</Code><Message>...</Message></Error>
  const code = body.match(/<Code>([^<]+)<\/Code>/)?.[1];
  const message = body.match(/<Message>([^<]+)<\/Message>/)?.[1];
  if (code || message) return { code: code ?? 'Unknown', message: message ?? body };
  return null;
}

function uploadWithProgress(
  method: 'PUT' | 'POST',
  url: string,
  body: XMLHttpRequestBodyInit,
  headers: Record<string, string>,
  onProgress: (loaded: number, total: number) => void,
): Promise<{ status: number; etag: string | null }> {
  return new Promise((resolveUpload, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded, e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolveUpload({ status: xhr.status, etag: xhr.getResponseHeader('ETag') });
      } else {
        const s3 = parseS3ErrorBody(xhr.responseText);
        if (s3) reject(new Error(`${xhr.status} ${s3.code}: ${s3.message}`));
        else reject(new Error(`Upload failed: ${xhr.status} ${xhr.responseText}`));
      }
    };
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.onabort = () => reject(new Error('Upload aborted'));
    xhr.send(body);
  });
}

async function uploadFile(
  mode: Mode,
  file: File,
  setStatus: (s: string, kind?: 'ok' | 'err') => void,
  setProgress: (pct: number, kind?: 'progress' | 'done' | 'error') => void,
  setRaw: (payload: unknown) => void,
): Promise<void> {
  setStatus('requesting presign...');
  let payload: PresignResponse;
  try {
    payload = await getPresign(mode, {
      filename: file.name,
      contentType: file.type || 'application/octet-stream',
      size: file.size,
    });
  } catch (err) {
    setStatus((err as Error).message, 'err');
    setProgress(0, 'error');
    return;
  }
  setRaw(payload);

  setStatus('uploading...');
  const onProgress = (loaded: number, total: number) => {
    setProgress((loaded / total) * 100, 'progress');
  };

  try {
    if (payload.mode === 'PUT') {
      const put = payload as PresignedPutResponse;
      await uploadWithProgress('PUT', put.uploadUrl, file, put.headers, onProgress);
    } else {
      const post = payload as PresignedPostResponse;
      const form = new FormData();
      for (const [k, v] of Object.entries(post.fields)) form.append(k, v);
      form.append('file', file); // file must be LAST
      await uploadWithProgress('POST', post.uploadUrl, form, {}, onProgress);
    }
    setProgress(100, 'done');
    setStatus(`done — ${payload.key}`, 'ok');
  } catch (err) {
    setStatus((err as Error).message, 'err');
    setProgress(0, 'error');
  }
}

async function refreshUploadedList(ui: UI): Promise<void> {
  try {
    const r = await fetch('/api/files');
    if (!r.ok) return;
    const data = (await r.json()) as ListFilesResponse;
    ui.uploaded.innerHTML = '';
    if (!data.files.length) {
      const li = document.createElement('li');
      li.textContent = data.mode === 'real'
        ? 'Listing not available in real-AWS mode — check the S3 console.'
        : '(no uploads yet)';
      li.style.background = '#f6f8fa';
      li.style.borderColor = '#d0d7de';
      li.style.color = '#586069';
      ui.uploaded.appendChild(li);
      return;
    }
    for (const f of data.files) {
      const li = document.createElement('li');
      const key = document.createElement('div');
      key.className = 'key';
      key.textContent = f.key;
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = `${fmtBytes(f.size)} · ${f.contentType} · via ${f.via} · ${f.uploadedAt}`;
      li.appendChild(key);
      li.appendChild(meta);
      ui.uploaded.appendChild(li);
    }
  } catch {
    // ignore
  }
}

function makeFileRow(file: File): {
  li: HTMLLIElement;
  setStatus: (s: string, kind?: 'ok' | 'err') => void;
  setProgress: (pct: number, kind?: 'progress' | 'done' | 'error') => void;
} {
  const li = document.createElement('li');
  const name = document.createElement('div');
  name.className = 'name';
  const strong = document.createElement('strong');
  strong.textContent = file.name;
  const size = document.createElement('span');
  size.className = 'meta';
  size.textContent = `${fmtBytes(file.size)} · ${file.type || 'application/octet-stream'}`;
  name.appendChild(strong);
  name.appendChild(size);

  const status = document.createElement('div');
  status.className = 'status';
  status.textContent = 'queued';

  const progress = document.createElement('div');
  progress.className = 'progress';
  const bar = document.createElement('span');
  progress.appendChild(bar);

  li.appendChild(name);
  li.appendChild(progress);
  li.appendChild(status);

  return {
    li,
    setStatus(s, kind) {
      status.textContent = s;
      status.className = 'status' + (kind === 'err' ? ' error' : kind === 'ok' ? ' done' : '');
    },
    setProgress(pct, kind) {
      bar.style.width = `${Math.min(100, Math.max(0, pct))}%`;
      progress.className = 'progress' + (kind === 'done' ? ' done' : kind === 'error' ? ' error' : '');
    },
  };
}

async function loadModeBanner(modeEl: HTMLElement, mode: Mode): Promise<void> {
  try {
    const c = await (await fetch('/api/config')).json();
    modeEl.textContent = `Server mode: ${String(c.mode).toUpperCase()} — bucket=${c.bucket} region=${c.region} expiry=${c.presignExpiresIn}s`;
    if (mode === 'POST') {
      const cEl = document.querySelector('#constraints');
      if (cEl) {
        const maxMb = (c.maxUploadBytes / 1024 / 1024).toFixed(2);
        cEl.textContent =
          `Active POST policy: max ${maxMb} MB · Content-Type must start with "${c.allowedContentTypePrefix ?? '(any)'}" · key must start with "${c.keyPrefix}"`;
      }
    }
  } catch {
    modeEl.textContent = 'Server mode: unknown';
  }
}

export function startDemo(mode: Mode): void {
  const ui: UI = {
    dropzone: $('#dropzone'),
    fileInput: $('#dropzone input[type=file]') as HTMLInputElement,
    fileList: $('#filelist') as HTMLUListElement,
    uploaded: $('#uploaded') as HTMLUListElement,
    raw: $('#raw') as HTMLPreElement,
    modeInfo: $('#mode-info'),
  };

  loadModeBanner(ui.modeInfo, mode);
  refreshUploadedList(ui);

  const handleFiles = async (files: FileList | File[]) => {
    const arr = Array.from(files);
    if (!arr.length) return;
    for (const file of arr) {
      const row = makeFileRow(file);
      ui.fileList.prepend(row.li);
      uploadFile(
        mode,
        file,
        row.setStatus,
        row.setProgress,
        (payload) => {
          ui.raw.textContent = JSON.stringify(payload, null, 2);
        },
      ).then(() => refreshUploadedList(ui));
    }
  };

  ui.dropzone.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).tagName !== 'INPUT') ui.fileInput.click();
  });
  ui.fileInput.addEventListener('change', () => {
    if (ui.fileInput.files) handleFiles(ui.fileInput.files);
    ui.fileInput.value = '';
  });
  ui.dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    ui.dropzone.classList.add('dragging');
  });
  ui.dropzone.addEventListener('dragleave', () => {
    ui.dropzone.classList.remove('dragging');
  });
  ui.dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    ui.dropzone.classList.remove('dragging');
    if (e.dataTransfer?.files) handleFiles(e.dataTransfer.files);
  });
}
