import { Router } from 'express';
import {
  deleteTopicLabelOverride, hasRunningAdminJob, listTopicLabelReviews,
  publishPassingTopicLabels, selectTopicLabelCandidate, updateTopicManualLabel
} from '../db.js';
import { createAndStartAdminWorkerJob } from '../services/adminWorker.js';
import { asyncHandler } from '../middleware/http.js';

export function createAdminTopicLabelsRouter({ clearMetricsCache }) {
  const router = Router();

  router.get('/topics/labels', asyncHandler(async (_req, res) => {
    res.status(200).json(await listTopicLabelReviews());
  }));

  router.post('/topics/labels/regenerate', asyncHandler(async (req, res) => {
    const runningId = await hasRunningAdminJob('topic_labels');
    if (runningId) {
      res.status(202).json({ ok: true, alreadyRunning: true, jobId: runningId });
      return;
    }
    const topicId = req.body?.topicId != null ? Number(req.body.topicId) : null;
    if (topicId != null && !Number.isInteger(topicId)) {
      res.status(400).json({ error: 'Invalid topic id.' });
      return;
    }
    const result = await createAndStartAdminWorkerJob({
      type: 'topic_labels',
      label: topicId == null ? 'Regenerate Topic Labels' : `Regenerate Topic ${topicId} Label`,
      params: { topicId },
    });
    res.status(202).json({ ok: true, started: true, ...result });
  }));

  router.post('/topics/:topicId/labels/select', asyncHandler(async (req, res) => {
    const topicId = Number(req.params.topicId);
    const candidateId = Number(req.body?.candidateId);
    if (!Number.isInteger(topicId) || !Number.isInteger(candidateId)) {
      res.status(400).json({ error: 'Invalid topic or candidate id.' });
      return;
    }
    const result = await selectTopicLabelCandidate(topicId, candidateId);
    if (!result) {
      res.status(404).json({ error: 'Candidate not found.' });
      return;
    }
    clearMetricsCache();
    res.status(200).json({ ok: true, ...result });
  }));

  router.patch('/topics/:topicId/label', asyncHandler(async (req, res) => {
    const topicId = Number(req.params.topicId);
    const label = String(req.body?.label || '').trim();
    if (!Number.isInteger(topicId) || !label) {
      res.status(400).json({ error: 'A topic id and non-empty label are required.' });
      return;
    }
    if (label.length > 120) {
      res.status(400).json({ error: 'Label must be 120 characters or fewer.' });
      return;
    }
    const result = await updateTopicManualLabel(topicId, label);
    if (!result) {
      res.status(404).json({ error: 'Topic not found.' });
      return;
    }
    clearMetricsCache();
    res.status(200).json({ ok: true, ...result });
  }));

  router.delete('/topics/:topicId/label/override', asyncHandler(async (req, res) => {
    const topicId = Number(req.params.topicId);
    if (!Number.isInteger(topicId)) {
      res.status(400).json({ error: 'Invalid topic id.' });
      return;
    }
    const removed = await deleteTopicLabelOverride(topicId);
    res.status(200).json({ ok: true, removed });
  }));

  router.post('/topics/labels/publish-passing', asyncHandler(async (_req, res) => {
    const result = await publishPassingTopicLabels();
    clearMetricsCache();
    res.status(200).json({ ok: true, ...result });
  }));

  return router;
}
