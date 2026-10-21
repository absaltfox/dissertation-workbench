import { test as base, expect } from '@playwright/test';

// public/index.html loads Google Fonts on purpose. Answer those with empty
// responses so the suite stays offline and deterministic without the aborted
// requests surfacing as console errors.
const FONT_HOSTS = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//;

// Any uncaught page error or console.error fails the test. Every other
// non-local request is aborted and recorded, so a regression that reaches for
// the network shows up as a failed test, not a hang.
export const test = base.extend({
  page: async ({ page }, use) => {
    const problems = [];
    page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') problems.push(`console.error: ${msg.text()}`);
    });
    await page.route(FONT_HOSTS, (route) => route.fulfill({
      status: 200,
      contentType: route.request().resourceType() === 'stylesheet' ? 'text/css' : 'font/woff2',
      body: '',
    }));
    await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost|fonts\.(googleapis|gstatic)\.com)/, (route) => {
      problems.push(`external request: ${route.request().url()}`);
      return route.abort();
    });
    await use(page);
    expect(problems, 'browser errors during test').toEqual([]);
  },
});

export { expect };
