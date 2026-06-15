import {
  appendAdminJobLog, clearAllCitations, getDb, listFileMetrics, listImportRules,
  loadCommitteeMembers, loadDocumentMetadata, updateAdminJob
} from '../db.js';
import {
  analyzeDocumentFile, analyzePdfAtPath, deleteCachedPdf, extractAndSaveParsedData
} from '../pdf.js';
import { runPendingCatalogueLookups } from '../catalogue.js';
import { getConfiguredApiKey } from '../secrets.js';
import { importRuleToSyncOptions } from '../importRules.js';

async function log(jobId, message) {
  await appendAdminJobLog(jobId, `[${new Date().toISOString()}] ${message}\n`);
}

async function analyzePdfEntry(entry, artifactClient) {
  if (artifactClient) {
    const remote = await artifactClient.downloadPdfToTemp(entry.doc_id);
    if (!remote?.path) return null;
    try {
      return await analyzePdfAtPath(remote.path);
    } finally {
      await remote.cleanup?.();
    }
  }
  return analyzePdfAtPath(entry.pdf_path);
}

export async function runImportPdfAdminJob(job, { artifactClient = null, clearMetricsCache = null } = {}) {
  const params = job.params || {};

  if (job.type === 'document_sync') {
    const { runDocumentSync } = await import('../sync.js');
    await log(job.id, 'Starting Open Collections document sync.');
    const result = await runDocumentSync({
      ...(params.options || {}),
      apiKey: await getConfiguredApiKey(),
      artifactClient,
    });
    clearMetricsCache?.();
    await updateAdminJob(job.id, {
      status: result.ok ? 'completed' : 'failed',
      result,
      error: result.ok ? null : result.error || 'Document sync failed',
      finishedAt: new Date().toISOString(),
    });
    await log(job.id, `Document sync finished: ${result.totalSaved || 0} saved, ${result.totalSkipped || 0} skipped.`);
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
    const apiKey = await getConfiguredApiKey();
    const perRule = [];
    const totals = { rulesStarted: 0, totalSeen: 0, totalSaved: 0, totalSkipped: 0 };
    for (const rule of rules) {
      await log(job.id, `Syncing rule "${rule.name}" (${rule.id}).`);
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
    await updateAdminJob(job.id, {
      status: result.ok ? 'completed' : 'failed',
      result,
      error: result.ok ? null : 'One or more import rules failed.',
      finishedAt: new Date().toISOString(),
    });
    await log(job.id, 'Import rules sync finished.');
    return result;
  }

  if (job.type === 'cache_refresh_doc') {
    const docId = params.docId;
    const doc = await loadDocumentMetadata(docId);
    if (!doc) throw new Error('Document not found in metadata store');
    await log(job.id, `Refreshing PDF/full-text analysis for ${docId}.`);
    if (!artifactClient) await deleteCachedPdf(docId);
    await analyzeDocumentFile(doc, {
      downloadFiles: true,
      forceDownload: true,
      recomputeFromCache: false,
      artifactClient,
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
    await updateAdminJob(job.id, {
      status: 'completed',
      result,
      finishedAt: new Date().toISOString(),
    });
    await log(job.id, `Refresh finished for ${docId}.`);
    return result;
  }

  if (job.type === 'reparse_all') {
    await log(job.id, 'Starting cached PDF reparse.');
    await clearAllCitations();
    const entries = (await listFileMetrics()).filter((entry) => entry.pdf_path);
    let processed = 0;
    let withCommittee = 0;
    let totalCitations = 0;
    for (const entry of entries) {
      try {
        const analysis = await analyzePdfEntry(entry, artifactClient);
        if (!analysis?.fullText) continue;
        processed += 1;
        const doc = await loadDocumentMetadata(entry.doc_id) || { id: entry.doc_id, supervisors: [] };
        await extractAndSaveParsedData(doc, analysis.fullText);
        if (doc.committee?.length) withCommittee += 1;
        if (doc.citationCount) totalCitations += Number(doc.citationCount);
      } catch (error) {
        await log(job.id, `Reparse failed for ${entry.doc_id}: ${error?.message || String(error)}`);
      }
    }
    const catalogueLookups = await runPendingCatalogueLookups();
    const result = { ok: true, processed, committees: withCommittee, citations: totalCitations, catalogueLookups };
    clearMetricsCache?.();
    await updateAdminJob(job.id, {
      status: 'completed',
      result,
      finishedAt: new Date().toISOString(),
    });
    await log(job.id, `Reparse finished: ${processed} processed.`);
    return result;
  }

  if (job.type === 'reparse_committee') {
    await log(job.id, 'Starting committee reparse.');
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
        const analysis = await analyzePdfEntry(row, artifactClient);
        if (analysis?.fullText) {
          const before = (await loadCommitteeMembers(row.doc_id)).length;
          await extractAndSaveParsedData(doc, analysis.fullText);
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
    await updateAdminJob(job.id, {
      status: 'completed',
      result,
      finishedAt: new Date().toISOString(),
    });
    await log(job.id, `Committee reparse finished: ${processed} processed.`);
    return result;
  }

  throw new Error(`Unsupported import/PDF admin job type: ${job.type}`);
}
