/* global window, document */ // used inside page.evaluate() callbacks
import { readFileSync } from 'node:fs';
import { test, expect } from './fixtures.js';

const CONSTRAINTS = new URL(
  '../.superpowers/sdd/2026-11-02-manuscripts-ui-and-research-bands/global-constraints.md',
  import.meta.url,
);
const constraintText = readFileSync(CONSTRAINTS, 'utf8');
const exact = (label) => {
  const m = constraintText.match(new RegExp(`${label}, exact: \`([^\`]+)\``));
  if (!m) throw new Error(`constraint "${label}" not found`);
  return m[1];
};
const HERO = exact('Hero subtitle');
const NOTICE = exact('Person Explorer notice');

async function openTab(page, tab) {
  await page.locator(`.tab-btn[data-tab="${tab}"]`).click();
  await expect(page.locator(`#tab-${tab}`)).toBeVisible();
}

test.describe('Part A: manuscripts UI', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#documentsTable tr.doc-row').first()).toBeVisible();
  });

  // PRODUCT BUG: buildWordCloud() (src/nlp.js) tokenises rec.subjects, and
  // src/metrics.js substitutes the "(Unspecified)" placeholder for empty
  // subjects, so "unspecified" is served in /api/metrics wordCloud and rendered.
  // The d909f54 fix only patched documentThemeTerms(), not buildWordCloud().
  test.fail('"unspecified" is never a word-cloud term (doc with no subjects is seeded)', async ({ page, request }) => {
    // The placeholder reaches records as "(Unspecified)"; make sure the seed exercises it.
    const res = await request.get('/api/metrics');
    expect(res.ok()).toBe(true);
    const payload = await res.json();
    expect(JSON.stringify(payload.wordCloud || [])).not.toMatch(/unspecified/i);

    await openTab(page, 'analytics');
    const terms = page.locator('#wordCloud .cloud-term');
    await expect(terms.first()).toBeVisible();
    expect(await terms.count()).toBeGreaterThan(5);
    const texts = (await terms.allTextContents()).map((t) => t.trim().toLowerCase());
    expect(texts.filter((t) => t.includes('unspecified'))).toEqual([]);
    await expect(page.locator('#ngramCloud')).not.toContainText(/unspecified/i);
  });

  test('Supervisor-Concept heatmap is gone; other heatmaps remain', async ({ page }) => {
    await openTab(page, 'analytics');
    await expect(page.locator('#tab-analytics')).not.toContainText(/Supervisor\s*[–-]\s*Concept/i);
    await expect(page.locator('#supervisorConceptHeatmap')).toHaveCount(0);
    // Methodology-Concept matrix still has its panel and renders content.
    await expect(page.getByRole('heading', { name: /Methodology . Concept Matrix/ })).toBeVisible();
    await expect(page.locator('#methodologyConceptHeatmap')).not.toBeEmpty();
    // Supervisor-Topic panel exists; it is only shown when enough data exists.
    await expect(page.locator('#supervisorTopicPanel')).toHaveCount(1);
    const visible = await page.locator('#supervisorTopicPanel').isVisible();
    if (visible) {
      await expect(page.locator('#supervisorTopicHeatmap')).not.toBeEmpty();
      await expect(page.locator('#supervisorTopicPanel h2')).toContainText(/Supervisor.*Topic/);
    }
  });

  test('visible copy says manuscripts, not dissertations', async ({ page }) => {
    // Document Explorer
    await expect(page.locator('#docFilter')).toHaveAttribute('placeholder', /Filter by title/);
    await expect(page.locator('.hero-stat, .hero-context, header.hero').first()).toContainText(/5\s+manuscripts/i);
    await expect(page.locator('#facetToggleSummary')).toHaveText('All manuscripts');

    // Citation Explorer
    await openTab(page, 'citations');
    await expect(page.locator('#citationDocFilter')).toHaveAttribute('placeholder', 'Filter manuscripts...');
    await expect(page.locator('#tab-citations')).toContainText(/Manuscripts \(\d+ with parsed citations, 5 total\)/);

    // Analytics
    await openTab(page, 'analytics');
    await expect(page.locator('#tab-analytics')).toContainText('Manuscripts by Year');
    await expect(page.locator('#tab-analytics')).toContainText('Manuscript Length Trend');
    await expect(page.locator('#kpis')).toContainText('Manuscripts');

    // Chart dataset labels (tooltips are drawn on canvas) use the new wording.
    const labels = await page.evaluate(() => {
      const canvas = document.querySelector('#dissertationsByYearChart canvas');
      const chart = window.Chart?.getChart?.(canvas);
      return chart ? chart.data.datasets.map((d) => d.label) : null;
    });
    if (labels) {
      for (const l of labels) expect(String(l)).not.toMatch(/dissertation/i);
    }

    // Visible text anywhere: "dissertation" may only occur in the approved
    // owner-copy phrases (title/H1, "theses and dissertations", the notice).
    for (const tab of ['records', 'citations', 'people', 'analytics']) {
      await openTab(page, tab);
      const text = await page.locator(`#tab-${tab}`).innerText();
      const stripped = text
        .replaceAll(NOTICE, '')
        .replace(/theses and dissertations/gi, '')
        .replace(/Dissertation Workbench/g, '');
      expect(stripped, `${tab} tab`).not.toMatch(/dissertation/i);
    }
  });

  test('title and H1 keep the tool name', async ({ page }) => {
    await expect(page).toHaveTitle('Dissertation Workbench');
    await expect(page.locator('h1')).toHaveText('Dissertation Workbench');
  });

  test('hero subtitle shows the exact approved text', async ({ page }) => {
    await expect(page.locator('header.hero .subtitle')).toHaveText(HERO);
  });

  test('people provenance notice shows exact text directly under the filter row', async ({ page }) => {
    await openTab(page, 'people');
    const notice = page.locator('#peopleProvenanceNotice');
    await expect(notice).toBeVisible();
    await expect(notice).toHaveText(NOTICE);
    // Directly under the filter row: filter input and notice are adjacent block siblings.
    const adjacent = await page.evaluate(() => {
      const row = document.getElementById('personFilter').parentElement;
      return row.nextElementSibling?.id === 'peopleProvenanceNotice';
    });
    expect(adjacent).toBe(true);
  });
});
