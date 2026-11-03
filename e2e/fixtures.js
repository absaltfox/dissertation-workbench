import { test as base, expect } from '@playwright/test';

// public/index.html loads Google Fonts on purpose. Answer those with empty
// responses so the suite stays offline and deterministic without the aborted
// requests surfacing as console errors.
const FONT_HOSTS = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//;

// Any uncaught page error or console.error fails the test. Every other
// non-local request is aborted and recorded, so a regression that reaches for
// the network shows up as a failed test, not a hang.
// `allowedConsoleErrors` (regex list, default none) lets a spec tolerate an
// expected browser-logged failure, e.g. the 404 probe on a gated admin server.
let nextClient = 0;

export const test = base.extend({
  allowedConsoleErrors: [[], { option: true }],
  page: async ({ page, allowedConsoleErrors }, use) => {
    // Distinct client IP per test (see TRUST_PROXY in start-server.mjs) so the
    // per-IP API rate limit never throttles an unrelated test.
    nextClient += 1;
    await page.setExtraHTTPHeaders({ 'x-forwarded-for': `10.${(nextClient >> 8) & 255}.${nextClient & 255}.7` });
    const problems = [];
    page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !allowedConsoleErrors.some((re) => re.test(msg.text()))) problems.push(`console.error: ${msg.text()}`);
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
