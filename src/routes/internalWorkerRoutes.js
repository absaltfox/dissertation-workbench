import express, { Router } from 'express';
import fs from 'node:fs/promises';
import {
  loadStoredFileMetric, validateAdminJobArtifactToken
} from '../db.js';
import {
  saveFullTextArtifactForDoc, savePdfArtifactForDoc
} from '../pdf.js';
import { MAX_DOWNLOAD_BYTES } from '../config.js';
import { asyncHandler } from '../middleware/http.js';

function bearerToken(req) {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function validDocId(value) {
  const text = String(value || '').trim();
  return text && !text.includes('/') && !text.includes('\\') && text.length <= 200;
}

async function requireWorkerToken(req, res, next) {
  if (!await validateAdminJobArtifactToken(req.params.jobId, bearerToken(req))) {
    res.status(401).json({ error: 'Invalid worker artifact token' });
    return;
  }
  if (!validDocId(req.params.docId)) {
    res.status(400).json({ error: 'Invalid document id' });
    return;
  }
  next();
}

async function sendArtifact(res, filePath, contentType) {
  if (!filePath) {
    res.status(404).json({ error: 'Artifact not found' });
    return;
  }
  try {
    const bytes = await fs.readFile(filePath);
    res.set('content-type', contentType);
    res.set('x-artifact-path', filePath);
    res.status(200).send(bytes);
  } catch {
    res.status(404).json({ error: 'Artifact not found' });
  }
}

export function createInternalWorkerRouter() {
  const router = Router();
  const rawBody = express.raw({
    type: ['application/pdf', 'application/octet-stream', 'text/plain', 'text/*'],
    limit: MAX_DOWNLOAD_BYTES,
  });

  router.get('/jobs/:jobId/artifacts/pdf/:docId', requireWorkerToken, asyncHandler(async (req, res) => {
    const stored = await loadStoredFileMetric(req.params.docId);
    await sendArtifact(res, stored?.pdf_path, 'application/pdf');
  }));

  router.get('/jobs/:jobId/artifacts/full-text/:docId', requireWorkerToken, asyncHandler(async (req, res) => {
    const stored = await loadStoredFileMetric(req.params.docId);
    await sendArtifact(res, stored?.full_text_path, 'text/plain; charset=utf-8');
  }));

  router.put('/jobs/:jobId/artifacts/pdf/:docId', requireWorkerToken, rawBody, asyncHandler(async (req, res) => {
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
    if (!bytes.length) {
      res.status(400).json({ error: 'PDF upload body is empty' });
      return;
    }
    const artifact = await savePdfArtifactForDoc(req.params.docId, bytes, {
      downloadUrl: req.get('x-download-url') || '',
    });
    res.status(200).json(artifact);
  }));

  router.put('/jobs/:jobId/artifacts/full-text/:docId', requireWorkerToken, rawBody, asyncHandler(async (req, res) => {
    const fullText = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');
    if (!fullText.trim()) {
      res.status(400).json({ error: 'Full-text upload body is empty' });
      return;
    }
    const artifact = await saveFullTextArtifactForDoc(req.params.docId, fullText, {
      sourceUrl: req.get('x-source-url') || '',
    });
    res.status(200).json(artifact);
  }));

  return router;
}
