import { test, expect } from './fixtures.js';
import { FIXTURE_DOCS } from './fixture-docs.mjs';

const docRows = (page) => page.locator('#documentsTable tr.doc-row');

async function openTab(page, tab) {
  await page.locator(`.tab-btn[data-tab="${tab}"]`).click();
  await expect(page.locator(`#tab-${tab}`)).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('document explorer lists every seeded document', async ({ page }) => {
  await expect(docRows(page)).toHaveCount(FIXTURE_DOCS.length);
  for (const doc of FIXTURE_DOCS) {
    await expect(page.locator('#documentsTable')).toContainText(doc.title);
  }
});

test('filter narrows the document table', async ({ page }) => {
  await expect(docRows(page)).toHaveCount(FIXTURE_DOCS.length);
  await page.locator('#docFilter').fill('Indigenous');
  await expect(docRows(page)).toHaveCount(1);
  await expect(docRows(page).first()).toContainText('Indigenous Land-Based Pedagogy');
});

test('clicking a document opens and closes the detail modal', async ({ page }) => {
  const target = FIXTURE_DOCS[0];
  await page.locator(`#documentsTable tr[data-doc-id="${target.id}"] .doc-title-cell`).click();
  const modal = page.locator('#docModalOverlay');
  await expect(modal).toBeVisible();
  await expect(page.locator('#docModalTitle')).toContainText(target.title);
  await page.locator('#docModalClose').click();
  await expect(modal).toBeHidden();
});

test('citation explorer lists documents with citations', async ({ page }) => {
  await openTab(page, 'citations');
  await expect(page.locator('#citationDocsTable tr.citation-doc-row').first()).toBeVisible();
});

test('person explorer lists supervisors', async ({ page }) => {
  await openTab(page, 'people');
  await expect(page.locator('#personTable')).toContainText('Jane Supervisor');
});

test('analytics dashboard renders year charts', async ({ page }) => {
  await openTab(page, 'analytics');
  for (const id of ['dissertationsByYearChart', 'pagesByYearChart', 'wordsByYearChart']) {
    const canvas = page.locator(`#${id} canvas`);
    await expect(canvas).toBeVisible();
    // Chart.js sets an explicit pixel size when it draws; a bare <canvas>
    // keeps the 300x150 default or 0 if hidden.
    await expect.poll(async () => canvas.evaluate((c) => c.width > 0 && c.height > 0 && c.height !== 150))
      .toBe(true);
  }
});

test('facet filters narrow the topic cluster scatter', async ({ page }) => {
  await openTab(page, 'analytics');
  await page.locator('.sub-tab-btn[data-analytics-tab="visualizations"]').click();
  const legend = page.locator('#topicClusterLegend');
  await expect(legend).toContainText('Mathematics and Teacher Identity (3)');
  await expect(legend).toContainText('Assessment and Literacy (2)');

  // e2e-doc-5 is the only MA document, assigned to topic 1.
  await page.locator('#filterDegree').selectOption('Master of Arts - MA');
  await expect(legend).toContainText('Assessment and Literacy (1)');
  await expect(legend).not.toContainText('Mathematics and Teacher Identity');

  // Switching sub-tabs away and back keeps the filtered view.
  await page.locator('.sub-tab-btn[data-analytics-tab="dashboard"]').click();
  await page.locator('.sub-tab-btn[data-analytics-tab="visualizations"]').click();
  await expect(legend).toContainText('Assessment and Literacy (1)');
  await expect(legend).not.toContainText('Mathematics and Teacher Identity');
});

test('a facet chosen on the dashboard sub-tab applies when visualizations open', async ({ page }) => {
  await openTab(page, 'analytics');
  await page.locator('#filterDegree').selectOption('Master of Arts - MA');
  await page.locator('.sub-tab-btn[data-analytics-tab="visualizations"]').click();
  const legend = page.locator('#topicClusterLegend');
  await expect(legend).toContainText('Assessment and Literacy (1)');
  await expect(legend).not.toContainText('Mathematics and Teacher Identity');
});

test('a facet chosen on another tab applies when returning to visualizations', async ({ page }) => {
  await openTab(page, 'analytics');
  await page.locator('.sub-tab-btn[data-analytics-tab="visualizations"]').click();
  const legend = page.locator('#topicClusterLegend');
  await expect(legend).toContainText('Mathematics and Teacher Identity (3)');

  await openTab(page, 'records');
  await page.locator('#filterDegree').selectOption('Master of Arts - MA');
  await expect(docRows(page)).toHaveCount(1);
  await openTab(page, 'analytics');
  await expect(legend).toContainText('Assessment and Literacy (1)');
  await expect(legend).not.toContainText('Mathematics and Teacher Identity');
});

test('about tab renders without errors', async ({ page }) => {
  await openTab(page, 'about');
});
