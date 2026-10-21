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

test('about tab renders without errors', async ({ page }) => {
  await openTab(page, 'about');
});
