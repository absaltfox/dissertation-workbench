import {
  appendAdminJobLog, finishAdminJob, getDb, listFileMetrics, listImportRules,
  loadCommitteeMembers, loadDocumentMetadata, updateAdminJobProgress
} from '../db.js';
import {
  analyzeDocumentFile, analyzePdfAtPath, deleteCachedPdf, extractAndSaveParsedData
} from '../pdf.js';
import { getConfiguredApiKey } from '../secrets.js';
import { importRuleToSyncOptions } from '../importRules.js';

async function log(jobId, message) {
  await appendAdminJobLog(jobId, `[${new Date().toISOString()}] ${message}\n`);
}

function createProgressReporter(jobId) {
  const tasks = [];
  const taskIndex = new Map();

  return async function report(event = {}) {
    const key = event.phase || event.key || event.label || 'running';
    const label = event.label || event.currentTask || key;
    const status = event.status || 'running';
    const task = {
      key,
      label,
      status,
      detail: event.detail || null,
      counts: event.counts || null,
      updatedAt: new Date().toISOString(),
    };
    if (taskIndex.has(key)) {
      tasks[taskIndex.get(key)] = task;
    } else {
      taskIndex.set(key, tasks.length);
      tasks.push(task);
    }
    await updateAdminJobProgress(jobId, {
      phase: key,
      currentTask: status === 'completed' ? event.nextTask || label : label,
      tasks,
      counts: event.counts || null,
    });
  };
}

async function analyzePdfEntry(entry, artifactClient, { keepPdfPath = false } = {}) {
  if (artifactClient) {
    const remote = await artifactClient.downloadPdfToTemp(entry.doc_id);
    if (!remote?.path) return null;
    try {
      const analysis = await analyzePdfAtPath(remote.path);
      if (keepPdfPath) {
        return { ...analysis, pdfPath: remote.path, cleanup: remote.cleanup };
      }
      await remote.cleanup?.();
      return analysis;
    } catch (error) {
      await remote.cleanup?.();
      throw error;
    }
  }
  const analysis = await analyzePdfAtPath(entry.pdf_path);
  return keepPdfPath ? { ...analysis, pdfPath: entry.pdf_path } : analysis;
}

export async function runImportPdfAdminJob(job, { artifactClient = null, clearMetricsCache = null } = {}) {
  const params = job.params || {};
  const progress = createProgressReporter(job.id);

  if (job.type === 'document_sync') {
    const { runDocumentSync } = await import('../sync.js');
    await log(job.id, 'Starting Open Collections document sync.');
    await progress({ phase: 'document_sync', label: 'Syncing Open Collections metadata', status: 'running' });
    const result = await runDocumentSync({
      ...(params.options || {}),
      apiKey: await getConfiguredApiKey(),
      artifactClient,
    });
    clearMetricsCache?.();
    await finishAdminJob(job.id, {
      status: result.ok ? 'completed' : 'failed',
      result,
      error: result.ok ? null : result.error || 'Document sync failed',
      finishedAt: new Date().toISOString(),
    });
    await log(job.id, `Document sync finished: ${result.totalSaved || 0} saved, ${result.totalSkipped || 0} skipped.`);
    await progress({
      phase: 'document_sync',
      label: 'Open Collections metadata sync',
      status: 'completed',
      counts: { saved: result.totalSaved || 0, skipped: result.totalSkipped || 0 },
    });
    return result;
  }

  if (job.type === 'import_rules_sync') {
    const { runDocumentSync } = await import('../sync.js');
    const allRules = await listImportRules();
    const selectedIds = Array.isArray(params.ruleIds)
      ? params.ruleIds.map((id) => String(id || '').trim()).filter(Boolean)
      : [];
    const rules = params.scope === 'all' ? allRules : allRules.filter((rule) => selectedIds.includes(rule.id));
    if (!rules.length) throw new Error(params.scope === 'all' ? 'No import rules are saved.' : 'Select at least one import rule.');

    await log(job.id, `Starting import rules sync (${params.mode}, ${params.scope}).`);
    await progress({ phase: 'import_rules', label: 'Running import rules', status: 'running' });
    const apiKey = await getConfiguredApiKey();
    const perRule = [];
    const totals = { rulesStarted: 0, totalSeen: 0, totalSaved: 0, totalSkipped: 0 };
    for (const rule of rules) {
      await log(job.id, `Syncing rule "${rule.name}" (${rule.id}).`);
      await progress({
        phase: 'import_rules',
        label: 'Running import rules',
        detail: `Syncing ${rule.name}`,
        status: 'running',
        counts: { processed: perRule.length, total: rules.length },
      });
      const result = await runDocumentSync({
        ...importRuleToSyncOptions(rule, {
          mode: params.mode,
          downloadFiles: params.downloadFiles,
          apiKey,
        }),
        artifactClient,
      });
      totals.rulesStarted += 1;
      totals.totalSeen += Number(result.totalSeen || 0);
      totals.totalSaved += Number(result.totalSaved || 0);
      totals.totalSkipped += Number(result.totalSkipped || 0);
      perRule.push({
        ruleId: rule.id,
        ruleName: rule.name,
        syncKey: result.syncKey,
        ok: result.ok,
        totalSeen: result.totalSeen || 0,
        totalSaved: result.totalSaved || 0,
        totalSkipped: result.totalSkipped || 0,
        apiTotal: result.apiTotal ?? null,
        error: result.error || null,
      });
      await log(job.id, `Rule result: ${result.ok ? 'success' : 'failed'}; ${result.totalSaved || 0} saved.`);
    }
    const result = { ok: perRule.every((item) => item.ok), mode: params.mode, scope: params.scope, ...totals, rules: perRule };
    clearMetricsCache?.();
    await finishAdminJob(job.id, {
      status: result.ok ? 'completed' : 'failed',
      result,
      error: result.ok ? null : 'One or more import rules failed.',
      finishedAt: new Date().toISOString(),
    });
    await log(job.id, 'Import rules sync finished.');
    await progress({
      phase: 'import_rules',
      label: 'Import rules sync',
      status: 'completed',
      counts: { processed: perRule.length, total: rules.length, saved: totals.totalSaved },
    });
    return result;
  }

  if (job.type === 'cache_refresh_doc') {
    const docId = params.docId;
    await progress({ phase: 'metadata', label: 'Loading document metadata', status: 'running', detail: docId });
    const doc = await loadDocumentMetadata(docId);
    if (!doc) throw new Error('Document not found in metadata store');
    await progress({ phase: 'metadata', label: 'Loaded document metadata', status: 'completed', detail: docId });
    await log(job.id, `Refreshing PDF/full-text analysis for ${docId}.`);
    if (!artifactClient) await deleteCachedPdf(docId);
    await analyzeDocumentFile(doc, {
      downloadFiles: true,
      forceDownload: true,
      recomputeFromCache: false,
      artifactClient,
      onProgress: progress,
    });
    const result = {
      ok: true,
      docId,
      status: doc.downloadStatus,
      pages: doc.pages,
      pagesSource: doc.pagesSource,
      wordCount: doc.wordCount,
      wordCountSource: doc.wordCountSource,
      fileBytes: doc.fileBytes,
      downloadUrl: doc.downloadUrl,
      downloadError: doc.downloadError || null,
    };
    clearMetricsCache?.();
    await finishAdminJob(job.id, {
      status: 'completed',
      result,
      finishedAt: new Date().toISOString(),
    });
    await log(job.id, `Refresh finished for ${docId}.`);
    await progress({
      phase: 'complete',
      label: 'Refresh complete',
      status: 'completed',
      counts: { pages: doc.pages || 0, words: doc.wordCount || 0, citations: doc.citationCount || 0 },
    });
    return result;
  }

  if (job.type === 'cache_reanalyze_doc') {
    const docId = params.docId;
    await progress({ phase: 'metadata', label: 'Loading document metadata', status: 'running', detail: docId });
    const doc = await loadDocumentMetadata(docId);
    if (!doc) throw new Error('Document not found in metadata store');
    await progress({ phase: 'metadata', label: 'Loaded document metadata', status: 'completed', detail: docId });
    await log(job.id, `Reanalyzing cached PDF/full-text for ${docId}.`);
    await analyzeDocumentFile(doc, {
      downloadFiles: false,
      forceDownload: false,
      recomputeFromCache: true,
      artifactClient,
      onProgress: progress,
      extractCommittee: true,
      extractCitations: false,
    });
    const result = {
      ok: doc.downloadStatus !== 'cache_miss' && doc.downloadStatus !== 'cache_error',
      docId,
      status: doc.downloadStatus,
      pages: doc.pages,
      pagesSource: doc.pagesSource,
      wordCount: doc.wordCount,
      wordCountSource: doc.wordCountSource,
      fileBytes: doc.fileBytes,
      downloadUrl: doc.downloadUrl,
      downloadError: doc.downloadError || null,
    };
    clearMetricsCache?.();
    await finishAdminJob(job.id, {
      status: result.ok ? 'completed' : 'failed',
      result,
      error: result.ok ? null : result.downloadError || 'Cached PDF/full-text reanalysis failed.',
      finishedAt: new Date().toISOString(),
    });
    await log(job.id, `Cached reanalysis finished for ${docId}: ${result.status || 'unknown'}.`);
    await progress({
      phase: 'complete',
      label: 'Cached reanalysis complete',
      status: 'completed',
      counts: { pages: doc.pages || 0, words: doc.wordCount || 0 },
    });
    return result;
  }

  if (job.type === 'cache_reextract_citations_doc') {
    const docId = params.docId;
    await progress({ phase: 'metadata', label: 'Loading document metadata', status: 'running', detail: docId });
    const doc = await loadDocumentMetadata(docId);
    if (!doc) throw new Error('Document not found in metadata store');
    await progress({ phase: 'metadata', label: 'Loaded document metadata', status: 'completed', detail: docId });
    await log(job.id, `Re-extracting cached PDF citations for ${docId}.`);
    const entry = (await listFileMetrics()).find((item) => item.doc_id === docId && item.pdf_path);
    if (!entry) throw new Error('No cached PDF available for citation extraction.');
    const analysis = await analyzePdfEntry(entry, artifactClient, { keepPdfPath: true });
    try {
      if (!analysis?.fullText) throw new Error('Cached PDF text extraction returned no text.');
      await extractAndSaveParsedData(doc, analysis.fullText, analysis.pdfPath, {
        onProgress: progress,
        extractCommittee: false,
        extractCitations: true,
      });
    } finally {
      await analysis?.cleanup?.();
    }
    const result = {
      ok: true,
      docId,
      citations: doc.citationCount || 0,
    };
    clearMetricsCache?.();
    await finishAdminJob(job.id, {
      status: 'completed',
      result,
      finishedAt: new Date().toISOString(),
    });
    await log(job.id, `Citation re-extraction finished for ${docId}: ${result.citations} citations.`);
    await progress({
      phase: 'complete',
      label: 'Citation re-extraction complete',
      status: 'completed',
      counts: { citations: result.citations },
    });
    return result;
  }

  if (job.type === 'reparse_all') {
    await log(job.id, 'Starting cached PDF document reparse without citation extraction.');
    await progress({ phase: 'reparse_all', label: 'Reparsing cached PDF document data', status: 'running' });
    const entries = (await listFileMetrics()).filter((entry) => entry.pdf_path);
    let processed = 0;
    let withCommittee = 0;
    for (const entry of entries) {
      try {
        await progress({
          phase: 'reparse_all',
          label: 'Reparsing cached PDF document data',
          detail: entry.doc_id,
          status: 'running',
          counts: { processed, total: entries.length, withCommittee },
        });
        const analysis = await analyzePdfEntry(entry, artifactClient);
        if (!analysis?.fullText) continue;
        processed += 1;
        const doc = await loadDocumentMetadata(entry.doc_id) || { id: entry.doc_id, supervisors: [] };
        await extractAndSaveParsedData(doc, analysis.fullText, null, {
          onProgress: progress,
          extractCommittee: true,
          extractCitations: false,
        });
        if (doc.committee?.length) withCommittee += 1;
      } catch (error) {
        await log(job.id, `Reparse failed for ${entry.doc_id}: ${error?.message || String(error)}`);
      }
    }
    const result = { ok: true, processed, committees: withCommittee, citations: 0 };
    clearMetricsCache?.();
    await finishAdminJob(job.id, {
      status: 'completed',
      result,
      finishedAt: new Date().toISOString(),
    });
    await log(job.id, `Reparse finished: ${processed} processed.`);
    await progress({
      phase: 'reparse_all',
      label: 'Cached PDF document reparse',
      status: 'completed',
      counts: { processed, total: entries.length, withCommittee },
    });
    return result;
  }

  if (job.type === 'reparse_citations') {
    await log(job.id, 'Starting cached PDF citation re-extraction.');
    await progress({ phase: 'reparse_citations', label: 'Re-extracting cached PDF citations', status: 'running' });
    const entries = (await listFileMetrics()).filter((entry) => entry.pdf_path);
    let processed = 0;
    let totalCitations = 0;
    for (const entry of entries) {
      try {
        await progress({
          phase: 'reparse_citations',
          label: 'Re-extracting cached PDF citations',
          detail: entry.doc_id,
          status: 'running',
          counts: { processed, total: entries.length, citations: totalCitations },
        });
        const analysis = await analyzePdfEntry(entry, artifactClient, { keepPdfPath: true });
        try {
          if (!analysis?.fullText) continue;
          const doc = await loadDocumentMetadata(entry.doc_id) || { id: entry.doc_id, supervisors: [] };
          await extractAndSaveParsedData(doc, analysis.fullText, analysis.pdfPath, {
            onProgress: progress,
            extractCommittee: false,
            extractCitations: true,
          });
          processed += 1;
          if (doc.citationCount) totalCitations += Number(doc.citationCount);
        } finally {
          await analysis?.cleanup?.();
        }
      } catch (error) {
        await log(job.id, `Citation re-extraction failed for ${entry.doc_id}: ${error?.message || String(error)}`);
      }
    }
    const result = { ok: true, processed, citations: totalCitations };
    clearMetricsCache?.();
    await finishAdminJob(job.id, {
      status: 'completed',
      result,
      finishedAt: new Date().toISOString(),
    });
    await log(job.id, `Citation re-extraction finished: ${processed} processed.`);
    await progress({
      phase: 'reparse_citations',
      label: 'Cached PDF citation re-extraction',
      status: 'completed',
      counts: { processed, total: entries.length, citations: totalCitations },
    });
    return result;
  }

  if (job.type === 'reparse_committee') {
    await log(job.id, 'Starting committee reparse.');
    await progress({ phase: 'reparse_committee', label: 'Reparsing missing committees', status: 'running' });
    const targetResult = await (await getDb()).execute({
      sql: `
      SELECT fm.doc_id, fm.pdf_path
      FROM file_metrics fm
      WHERE fm.pdf_path IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM committee_members cm WHERE cm.doc_id = fm.doc_id
      )
    `});
    const targets = targetResult.rows;
    let processed = 0;
    let withCommittee = 0;
    for (const row of targets) {
      const doc = await loadDocumentMetadata(row.doc_id);
      if (!doc) continue;
      try {
        await progress({
          phase: 'reparse_committee',
          label: 'Reparsing missing committees',
          detail: row.doc_id,
          status: 'running',
          counts: { processed, total: targets.length, withCommittee },
        });
        const analysis = await analyzePdfEntry(row, artifactClient);
        if (analysis?.fullText) {
          const before = (await loadCommitteeMembers(row.doc_id)).length;
          await extractAndSaveParsedData(doc, analysis.fullText, null, {
            onProgress: progress,
            extractCommittee: true,
            extractCitations: false,
          });
          const after = (await loadCommitteeMembers(row.doc_id)).length;
          if (after > before) withCommittee += 1;
        }
      } catch (error) {
        await log(job.id, `Committee reparse failed for ${row.doc_id}: ${error?.message || String(error)}`);
      }
      processed += 1;
    }
    const result = { ok: true, processed, withCommittee };
    clearMetricsCache?.();
    await finishAdminJob(job.id, {
      status: 'completed',
      result,
      finishedAt: new Date().toISOString(),
    });
    await log(job.id, `Committee reparse finished: ${processed} processed.`);
    await progress({
      phase: 'reparse_committee',
      label: 'Committee reparse',
      status: 'completed',
      counts: { processed, total: targets.length, withCommittee },
    });
    return result;
  }

  throw new Error(`Unsupported import/PDF admin job type: ${job.type}`);
}
