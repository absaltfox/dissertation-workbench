import test from 'node:test';
import assert from 'node:assert/strict';
import {
  closeDb, createAdminJob, deleteImportRule, failEnrichmentRolloutForJob,
  finishEnrichmentRolloutPhase, getAdminJob, getEnrichmentRollout, hasRunningAdminJob,
  importRuleRevision,
  listEnrichmentRolloutEvidence, saveEnrichmentRolloutEvidence,
  saveImportRule, startEnrichmentRolloutPhase, updateAdminJob
} from '../src/db.js';

test.after(async () => closeDb());

test('rollout state advances only after durable phase evidence is evaluated', async () => {
  const rule = await saveImportRule({
    id: `rollout-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: 'Rollout state fixture',
    contentMode: 'full_text_only',
  });
  const ruleId = rule.id;
  const revision = importRuleRevision(rule);
  await startEnrichmentRolloutPhase(ruleId, 'sample', 101, revision);
  await saveEnrichmentRolloutEvidence({
    ruleId,
    ruleRevision: revision,
    phase: 'sample',
    jobId: 101,
    contentMode: 'full_text_only',
    outcomes: [{ docId: 'sample-doc', wordCount: 1000, pageCount: 4 }],
  });
  await finishEnrichmentRolloutPhase(ruleId, 'sample', 101, { passed: true, phase: 'sample' });

  const afterSample = await getEnrichmentRollout(ruleId);
  assert.equal(afterSample.status, 'awaiting_control');
  assert.equal(afterSample.sampleJobId, 101);
  assert.equal(afterSample.currentJobId, null);

  await startEnrichmentRolloutPhase(ruleId, 'control', 102, revision);
  await finishEnrichmentRolloutPhase(ruleId, 'control', 102, { passed: false, phase: 'control' });
  const blocked = await getEnrichmentRollout(ruleId);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.controlJobId, 102);

  const evidence = await listEnrichmentRolloutEvidence({ ruleId, jobId: 101 });
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].contentMode, 'full_text_only');
  assert.equal(evidence[0].outcome.docId, 'sample-doc');

  await startEnrichmentRolloutPhase(ruleId, 'control', 103, revision);
  await failEnrichmentRolloutForJob(103, new Error('worker timed out'));
  const interrupted = await getEnrichmentRollout(ruleId);
  assert.equal(interrupted.status, 'blocked');
  assert.equal(interrupted.evaluation.interrupted, true);
  assert.equal(interrupted.evaluation.phase, 'control');
  await deleteImportRule(ruleId);
});

test('an exhausted cohort completes the rollout and a stale worker becomes retryable', async () => {
  const rule = await saveImportRule({
    id: `terminal-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: 'Terminal fixture',
    contentMode: 'full_text_only',
  });
  const revision = importRuleRevision(rule);
  await startEnrichmentRolloutPhase(rule.id, 'sample', 301, revision);
  await finishEnrichmentRolloutPhase(rule.id, 'sample', 301, { passed: true, phase: 'sample' });
  await startEnrichmentRolloutPhase(rule.id, 'control', 302, revision);
  await finishEnrichmentRolloutPhase(rule.id, 'control', 302, { passed: true, phase: 'control' });
  await startEnrichmentRolloutPhase(rule.id, 'cohort', 303, revision);
  await finishEnrichmentRolloutPhase(rule.id, 'cohort', 303, {
    passed: true,
    phase: 'cohort',
    exhausted: true,
  });
  assert.equal((await getEnrichmentRollout(rule.id)).status, 'completed');

  await saveImportRule({ ...rule, degree: 'Fresh cohort' });
  const jobId = await createAdminJob({ type: 'import_rules_sync', label: 'Stale rollout fixture' });
  await startEnrichmentRolloutPhase(rule.id, 'sample', jobId, importRuleRevision({ ...rule, degree: 'Fresh cohort' }));
  await updateAdminJob(jobId, { heartbeatAt: new Date(Date.now() - 45 * 60 * 1000).toISOString() });
  assert.equal(await hasRunningAdminJob('import_rules_sync'), null);
  assert.equal((await getAdminJob(jobId)).status, 'timed_out');
  const recovered = await getEnrichmentRollout(rule.id);
  assert.equal(recovered.status, 'blocked');
  assert.equal(recovered.evaluation.interrupted, 1);
  assert.equal(recovered.evaluation.phase, 'sample');
  await deleteImportRule(rule.id);
});

test('changing or deleting an import rule cannot reuse its rollout approval', async () => {
  const rule = await saveImportRule({
    id: `revision-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: 'Revision fixture',
    degree: 'Degree A',
    contentMode: 'full_text_only',
  });
  const revision = importRuleRevision(rule);
  await startEnrichmentRolloutPhase(rule.id, 'sample', 201, revision);
  await finishEnrichmentRolloutPhase(rule.id, 'sample', 201, { passed: true, phase: 'sample' });

  await saveImportRule({ ...rule, degree: 'Degree B' });
  const invalidated = await getEnrichmentRollout(rule.id);
  assert.equal(invalidated.status, 'invalidated');
  assert.equal(invalidated.evaluation.reason, 'import_rule_changed');

  await assert.rejects(
    startEnrichmentRolloutPhase(rule.id, 'control', 202, revision),
    /(not allowed|changed)/
  );
  await deleteImportRule(rule.id);
  assert.equal(await getEnrichmentRollout(rule.id), null);
});
