import { test as base, expect } from '@playwright/test';

// public/index.html loads Google Fonts on purpose. Answer those with empty
// responses so the suite stays offline and deterministic without the aborted
// requests surfacing as console errors.
const FONT_HOSTS = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//;

// Any uncaught page error or console.error fails the test. Every other
// non-local request is aborted and recorded, so a regression that reaches for
// the network shows up as a failed test, not a hang.
// `allowedConsoleErrors` is a list of `{ text: RegExp, urlPattern: RegExp }`
// (default none). A console.error is tolerated only if BOTH match: its text and
// the URL of the failing resource (msg.location().url). This keeps a specific,
// expected browser-logged failure (e.g. the 404 probe on a gated admin server)
// from masking any other broken asset or API call.
let nextClient = 0;

export const test = base.extend({
  allowedConsoleErrors: [[], { option: true }],
  page: async ({ page, allowedConsoleErrors }, use) => {
    // Distinct client IP per test (see TRUST_PROXY in start-server.mjs) so the
    // app's 120/min per-IP API rate limit never throttles an unrelated test.
    // This hides the limiter from the suite on purpose; regression.spec.js
    // ("Rate limiter") proves it still works.
    nextClient += 1;
    await page.setExtraHTTPHeaders({ 'x-forwarded-for': `10.${(nextClient >> 8) & 255}.${nextClient & 255}.7` });
    const problems = [];
    page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const allowed = allowedConsoleErrors.some((a) => a.text.test(msg.text()) && a.urlPattern.test(msg.location().url || ''));
      if (!allowed) problems.push(`console.error: ${msg.text()} (${msg.location().url})`);
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
