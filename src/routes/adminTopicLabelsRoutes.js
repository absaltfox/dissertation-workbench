import { Router } from 'express';
import {
  deleteTopicBandLabelOverride, deleteTopicLabelOverride, getSetting, hasRunningAdminJob,
  listTopicLabelReviews, loadTopicBands, loadTopics, publishPassingTopicLabels,
  selectTopicLabelCandidate, updateTopicBandManualLabel, updateTopicManualLabel
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
    // A bertopic run swaps in fresh topics and candidates; a concurrent labels
    // job would update live labels the swap then overwrites.
    const bertopicRunningId = await hasRunningAdminJob('bertopic');
    if (bertopicRunningId) {
      res.status(409).json({
        error: 'A BERTopic rebuild is running; wait for it to finish before regenerating labels.',
        bertopicRunning: true,
        jobId: bertopicRunningId,
      });
      return;
    }
    const bandsRunningId = await hasRunningAdminJob('topic_bands');
    if (bandsRunningId) {
      res.status(409).json({
        error: 'A research-area rebuild is running; wait for it to finish before regenerating labels.',
        bandsRunning: true,
        jobId: bandsRunningId,
      });
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

  router.post('/topics/bands/rebuild', asyncHandler(async (_req, res) => {
    const runningId = await hasRunningAdminJob('topic_bands');
    if (runningId) {
      res.status(202).json({ ok: true, alreadyRunning: true, jobId: runningId });
      return;
    }
    // Both jobs write band rows, and a bertopic run replaces the topics they sit on.
    for (const [type, name] of [['bertopic', 'A BERTopic rebuild'], ['topic_labels', 'A topic label job']]) {
      const otherId = await hasRunningAdminJob(type);
      if (otherId) {
        res.status(409).json({
          error: `${name} is running; wait for it to finish before rebuilding research areas.`,
          jobId: otherId,
          runningType: type,
        });
        return;
      }
    }
    const result = await createAndStartAdminWorkerJob({
      type: 'topic_bands',
      label: 'Rebuild Research Areas',
      params: {},
      singleInstance: true,
    });
    if (result.alreadyRunning) {
      res.status(202).json({ ok: true, alreadyRunning: true, jobId: result.jobId });
      return;
    }
    res.status(202).json({ ok: true, started: true, ...result });
  }));

  router.get('/topics/bands', asyncHandler(async (_req, res) => {
    const [bands, topics, generation] = await Promise.all([
      loadTopicBands(), loadTopics(), getSetting('topics_generation'),
    ]);
    const topicById = new Map(topics.map((t) => [t.topicId, t]));
    res.status(200).json({
      generation: generation ?? null,
      bands: (bands || []).map((band) => ({
        ...band,
        children: band.children.map((topicId) => ({
          topicId,
          label: topicById.get(topicId)?.label ?? `Topic ${topicId}`,
          docCount: topicById.get(topicId)?.docCount ?? 0,
        })),
      })),
    });
  }));

  router.patch('/topics/bands/:bandId/label', asyncHandler(async (req, res) => {
    if (!/^\d+$/.test(req.params.bandId) || typeof req.body?.label !== 'string') {
      res.status(400).json({ error: 'A band id and non-empty label are required.' });
      return;
    }
    const bandId = Number(req.params.bandId);
    const label = req.body.label.trim();
    if (!label) {
      res.status(400).json({ error: 'A band id and non-empty label are required.' });
      return;
    }
    if (label.length > 120) {
      res.status(400).json({ error: 'Label must be 120 characters or fewer.' });
      return;
    }
    if ((await getSetting('topics_generation')) == null) {
      res.status(409).json({ error: 'Rebuild topics before renaming research areas.' });
      return;
    }
    const result = await updateTopicBandManualLabel(bandId, label);
    if (!result) {
      res.status(404).json({ error: 'Research area not found.' });
      return;
    }
    clearMetricsCache();
    res.status(200).json({ ok: true, ...result });
  }));

  router.delete('/topics/bands/:bandId/label/override', asyncHandler(async (req, res) => {
    if (!/^\d+$/.test(req.params.bandId)) {
      res.status(400).json({ error: 'Invalid band id.' });
      return;
    }
    const bandId = Number(req.params.bandId);
    const removed = await deleteTopicBandLabelOverride(bandId);
    if (removed) clearMetricsCache();
    res.status(200).json({ ok: true, removed });
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
