import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  FLY_APP_NAME, PORT, WORKER_ARTIFACT_BASE_URL, WORKER_FORCE_ARTIFACT_API
} from './config.js';

function defaultBaseUrl() {
  if (WORKER_ARTIFACT_BASE_URL) return WORKER_ARTIFACT_BASE_URL.replace(/\/+$/, '');
  if (FLY_APP_NAME) return `http://${FLY_APP_NAME}.internal:${PORT}`;
  return `http://127.0.0.1:${PORT}`;
}

async function writeTempFile(ext, bytes) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-worker-artifact-'));
  const filePath = path.join(dir, `${crypto.randomUUID()}${ext}`);
  await fs.writeFile(filePath, bytes);
  return {
    path: filePath,
    cleanup: async () => {
      try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  };
}

export class WorkerArtifactClient {
  constructor({ baseUrl = defaultBaseUrl(), jobId, token }) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.jobId = jobId;
    this.token = token;
  }

  headers(extra = {}) {
    return {
      authorization: `Bearer ${this.token}`,
      ...extra,
    };
  }

  artifactUrl(kind, docId) {
    return `${this.baseUrl}/api/internal/jobs/${encodeURIComponent(this.jobId)}/artifacts/${kind}/${encodeURIComponent(docId)}`;
  }

  async downloadPdfToTemp(docId) {
    const res = await fetch(this.artifactUrl('pdf', docId), { headers: this.headers() });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`PDF artifact download failed (${res.status})`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const temp = await writeTempFile('.pdf', bytes);
    return {
      ...temp,
      bytes,
      pdfPath: res.headers.get('x-artifact-path') || null,
    };
  }

  async downloadFullText(docId) {
    const res = await fetch(this.artifactUrl('full-text', docId), { headers: this.headers() });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Full-text artifact download failed (${res.status})`);
    const fullText = await res.text();
    return {
      fullText,
      fullTextPath: res.headers.get('x-artifact-path') || null,
      fullTextBytes: Buffer.byteLength(fullText, 'utf8'),
    };
  }

  async uploadPdf(docId, bytes, downloadUrl = '') {
    const res = await fetch(this.artifactUrl('pdf', docId), {
      method: 'PUT',
      headers: this.headers({
        'content-type': 'application/pdf',
        'x-download-url': downloadUrl || '',
      }),
      body: bytes,
    });
    if (!res.ok) throw new Error(`PDF artifact upload failed (${res.status})`);
    return res.json();
  }

  async uploadFullText(docId, fullText, sourceUrl = '') {
    const res = await fetch(this.artifactUrl('full-text', docId), {
      method: 'PUT',
      headers: this.headers({
        'content-type': 'text/plain; charset=utf-8',
        'x-source-url': sourceUrl || '',
      }),
      body: fullText,
    });
    if (!res.ok) throw new Error(`Full-text artifact upload failed (${res.status})`);
    return res.json();
  }
}

export function createWorkerArtifactClientFromEnv() {
  const jobId = process.env.ADMIN_JOB_ID;
  const token = process.env.ADMIN_JOB_ARTIFACT_TOKEN;
  const useApi = WORKER_FORCE_ARTIFACT_API || Boolean(process.env.FLY_APP_NAME);
  if (!useApi || !jobId || !token) return null;
  return new WorkerArtifactClient({ jobId, token });
}
