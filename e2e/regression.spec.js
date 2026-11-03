/* global window, getComputedStyle */ // used inside page.evaluate() callbacks
import { test, expect } from './fixtures.js';
import { FIXTURE_DOCS } from './fixture-docs.mjs';

const docRows = (page) => page.locator('#documentsTable tr.doc-row');
const tab = (page, name) => page.locator(`.tab-btn[data-tab="${name}"]`);

async function openTab(page, name) {
  await tab(page, name).click();
  await expect(page.locator(`#tab-${name}`)).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(docRows(page)).toHaveCount(FIXTURE_DOCS.length);
});

test.describe('Document Explorer', () => {
  test('filter box narrows rows and restores when cleared; no-match shows empty table', async ({ page }) => {
    await page.locator('#docFilter').fill('Assessment');
    await expect(docRows(page)).toHaveCount(1);
    await page.locator('#docFilter').fill('zzzz-no-such-doc');
    await expect(docRows(page)).toHaveCount(0);
    await page.locator('#docFilter').fill('');
    await expect(docRows(page)).toHaveCount(FIXTURE_DOCS.length);
  });

  test('filtering by supervisor name matches', async ({ page }) => {
    await page.locator('#docFilter').fill('Morgan Supervisor');
    await expect(docRows(page)).toHaveCount(1);
    await expect(docRows(page).first()).toContainText('Digital Literacies');
  });

  test('facet select produces a chip and Clear removes it', async ({ page }) => {
    await page.locator('#filterDegree').selectOption('Doctor of Education - EdD');
    await expect(docRows(page)).toHaveCount(1);
    await expect(page.locator('#facetChips')).toContainText('Doctor of Education - EdD');
    await expect(page.locator('#facetToggleSummary')).not.toHaveText('All manuscripts');
    await page.locator('#clearFacets').click();
    await expect(docRows(page)).toHaveCount(FIXTURE_DOCS.length);
    await expect(page.locator('#facetToggleSummary')).toHaveText('All manuscripts');
  });

  test('document detail shows metadata; BibTeX and RIS buttons download files', async ({ page }) => {
    const target = FIXTURE_DOCS[1];
    await page.locator(`#documentsTable tr[data-doc-id="${target.id}"] .doc-title-cell`).click();
    await expect(page.locator('#docModalOverlay')).toBeVisible();
    await expect(page.locator('#docModalTitle')).toContainText(target.title);
    await expect(page.locator('#docModalOverlay')).toContainText(target.author);

    const [bib] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('[data-doc-bibtex]').click(),
    ]);
    expect(bib.suggestedFilename()).toMatch(/\.bib$/);
    const { createReadStream } = await import('node:fs');
    const read = async (d) => {
      const chunks = [];
      for await (const c of createReadStream(await d.path())) chunks.push(c);
      return Buffer.concat(chunks).toString('utf8');
    };
    const bibText = await read(bib);
    expect(bibText).toContain('@phdthesis');
    expect(bibText).toContain(target.title);

    const [ris] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('[data-doc-ris]').click(),
    ]);
    expect(ris.suggestedFilename()).toMatch(/\.ris$/);
    expect(await read(ris)).toContain('TY  -');
  });

  test('Escape closes the detail modal', async ({ page }) => {
    await page.locator(`#documentsTable tr[data-doc-id="${FIXTURE_DOCS[0].id}"] .doc-title-cell`).click();
    await expect(page.locator('#docModalOverlay')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#docModalOverlay')).toBeHidden();
  });

  test('list-level Export BibTeX / RIS download the filtered set', async ({ page }) => {
    await page.locator('#docFilter').fill('Indigenous');
    await expect(docRows(page)).toHaveCount(1);
    const [bib] = await Promise.all([page.waitForEvent('download'), page.locator('#exportBibTeX').click()]);
    expect(bib.suggestedFilename()).toBe('dissertations.bib');
    const [ris] = await Promise.all([page.waitForEvent('download'), page.locator('#exportRIS').click()]);
    expect(ris.suggestedFilename()).toBe('dissertations.ris');
  });
});

test.describe('Analytics', () => {
  test.beforeEach(async ({ page }) => {
    await openTab(page, 'analytics');
  });

  test('KPI cards show corpus totals', async ({ page }) => {
    const kpis = page.locator('#kpis .kpi');
    await expect(kpis.first()).toBeVisible();
    expect(await kpis.count()).toBeGreaterThanOrEqual(3);
    const manuscripts = kpis.filter({ hasText: 'Manuscripts' }).first();
    await expect(manuscripts.locator('strong')).toHaveText('5');
    await expect(kpis.filter({ hasText: 'Pages' }).first()).toContainText('120');
    await expect(kpis.filter({ hasText: 'Words' }).first()).toContainText('38,000');
  });

  test('Manuscripts by Year chart is drawn with one bar series point per year', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Manuscripts by Year' })).toBeVisible();
    const canvas = page.locator('#dissertationsByYearChart canvas');
    await expect(canvas).toBeVisible();
    await expect.poll(() => canvas.evaluate((c) => c.height > 0 && c.height !== 150)).toBe(true);
  });

  test('clicking a word-cloud term lists matching manuscripts', async ({ page }) => {
    const term = page.locator('#wordCloud .cloud-term[data-theme="mathematics"]');
    await expect(term).toBeVisible();
    await term.click();
    // The click opens a "Theme: <term>" matches panel listing tagged manuscripts.
    const modal = page.locator('#docModalOverlay');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('Theme: mathematics');
    await expect(modal).toContainText('manuscript(s)');
    await expect(modal).toContainText('Teaching Mathematics Through Play');
    await expect(modal).not.toContainText('Digital Literacies');
  });

  test('concept cloud and methodology panel render', async ({ page }) => {
    await expect(page.locator('#ngramCloud .cloud-term').first()).toBeVisible();
    // Methodology signals are detected from full text, which the fixtures lack.
    await expect(page.locator('#methodologyBars')).toContainText(/No methodology signals detected\.|\d/);
  });

  test('visualizations show topic clusters, timeline and dendrogram when topics exist', async ({ page }) => {
    await page.locator('.sub-tab-btn[data-analytics-tab="visualizations"]').click();
    await expect(page.locator('#topicClusterLegend')).toContainText('Mathematics and Teacher Identity (3)');
    await expect(page.locator('#topicClusterChart')).toBeVisible();
    await page.locator('.sub-tab-btn[data-analytics-tab="dashboard"]').click();
    await expect(page.locator('#topicDistPanel')).toBeVisible();
    await expect(page.locator('#topicBars')).toContainText('Mathematics and Teacher Identity');
  });
});

test.describe('Person Explorer', () => {
  test.beforeEach(async ({ page }) => {
    await openTab(page, 'people');
    await expect(page.locator('#personTable tr.doc-row').first()).toBeVisible();
  });

  test('lists people and shows a count', async ({ page }) => {
    for (const n of ['Jane Supervisor', 'Alex Supervisor', 'Morgan Supervisor']) {
      await expect(page.locator('#personTable')).toContainText(n);
    }
    await expect(page.locator('#personCount')).not.toBeEmpty();
  });

  test('filter narrows the list', async ({ page }) => {
    await page.locator('#personFilter').fill('Alex');
    await expect(page.locator('#personTable tr.doc-row')).toHaveCount(1);
    await expect(page.locator('#personTable')).toContainText('Alex Supervisor');
    await page.locator('#personFilter').fill('');
    await expect(page.locator('#personTable tr.doc-row')).not.toHaveCount(1);
  });

  test('role select can be changed and filters to examiners', async ({ page }) => {
    const select = page.locator('#personRoleFilter');
    const values = await select.locator('option').evaluateAll((os) => os.map((o) => o.value));
    expect(values.length).toBeGreaterThan(1);
    const examiner = values.find((v) => /examiner/i.test(v));
    if (examiner) {
      await select.selectOption(examiner);
      await expect(page.locator('#personTable tr.doc-row').first()).toBeVisible();
      await expect(page.locator('#personTable')).toContainText('Jane Supervisor');
    }
    await select.selectOption(values[0]);
  });

  test('opening a person shows their manuscripts', async ({ page }) => {
    await page.locator('#personTable tr.doc-row', { hasText: 'Alex Supervisor' }).click();
    const detail = page.locator('#personDetail');
    await expect(detail).toContainText('Alex Supervisor');
    await expect(detail).toContainText('Assessment Practices in Secondary Science');
    await expect(detail).toContainText('Teacher Identity and Early Career Attrition');
  });
});

test.describe('Citation Explorer', () => {
  test.beforeEach(async ({ page }) => {
    await openTab(page, 'citations');
    await expect(page.locator('#citationDocsTable tr.citation-doc-row').first()).toBeVisible();
  });

  test('selecting a manuscript shows its works cited', async ({ page }) => {
    await page.locator('#citationDocsTable tr.citation-doc-row', { hasText: 'Teaching Mathematics Through Play' }).click();
    await expect(page.locator('#citationEntries')).toContainText('Mind in society');
  });

  test('citation filter narrows manuscripts', async ({ page }) => {
    await page.locator('#citationDocFilter').fill('Digital Literacies');
    await expect(page.locator('#citationDocsTable tr.citation-doc-row')).toHaveCount(1);
  });

  test('foundational works lists the shared citation and opens linked manuscripts', async ({ page }) => {
    await page.locator('.sub-tab-btn[data-citation-tab="foundational"]').click();
    const item = page.locator('.foundational-work-item').first();
    await expect(item).toContainText('Mind in society');
    await expect(item).toContainText('2');
    await item.click();
    const modal = page.locator('#docModalOverlay');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('Linked Manuscripts');
    await expect(modal).toContainText('Teaching Mathematics Through Play');
    await expect(modal).toContainText('Indigenous Land-Based Pedagogy');
    // Navigating from a linked manuscript opens its detail.
    await modal.locator('.related-item', { hasText: 'Indigenous Land-Based Pedagogy' }).click();
    await expect(page.locator('#docModalTitle')).toContainText('Indigenous Land-Based Pedagogy');
  });
});

test.describe('About, routing, mobile', () => {
  test('about tab shows the project description', async ({ page }) => {
    await openTab(page, 'about');
    await expect(page.locator('#tab-about')).toContainText('Open Collections');
  });

  test('tab clicks update the hash and hash changes switch tabs', async ({ page }) => {
    const hashes = {};
    for (const name of ['citations', 'people', 'analytics', 'about', 'records']) {
      await openTab(page, name);
      hashes[name] = await page.evaluate(() => window.location.hash);
      expect(hashes[name]).toMatch(/^#\//);
    }
    await page.evaluate((h) => { window.location.hash = h; }, hashes.people);
    await expect(page.locator('#tab-people')).toBeVisible();
    await expect(page.locator('#tab-records')).toBeHidden();
    await page.goBack();
    await expect(page.locator('#tab-records')).toBeVisible();
  });

  test('loading a deep link opens that tab', async ({ page }) => {
    await openTab(page, 'analytics');
    const hash = await page.evaluate(() => window.location.hash);
    await page.goto(`/${hash}`);
    await expect(page.locator('#tab-analytics')).toBeVisible();
  });

  test('mobile viewport exposes short tab labels', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    const expected = { records: 'Docs', citations: 'Cites', people: 'People', analytics: 'Stats', about: 'About', admin: 'Admin' };
    for (const [name, label] of Object.entries(expected)) {
      const btn = tab(page, name);
      await expect(btn).toBeVisible();
      await expect(btn).toHaveAttribute('data-mobile-label', label);
      const after = await btn.evaluate((el) => getComputedStyle(el, '::after').content);
      expect(after).toBe(`"${label}"`);
    }
    await tab(page, 'people').click();
    await expect(page.locator('#tab-people')).toBeVisible();
    await expect(page.locator('#peopleProvenanceNotice')).toBeVisible();
  });
});
