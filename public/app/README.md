# Browser Code Layout

The browser app is served as native ES modules without a bundler. `index.html`
loads only `main.js`; route modules are dynamically imported when their tab or
surface is opened.

- `main.js`: startup coordinator, first-screen event binding, hash routing, and
  dynamic module registry.
- `core.js`: DOM references, shared state, formatting helpers, shell routing,
  vendor script loaders, and cross-feature document matching helpers.
- `documents.js`: first-load Document Explorer table, detail modal, related
  documents, and lazy document-detail rendering.
- `data.js`: staged Workbench API loading, facet filters, cache keys, and
  shared render/data hooks.
- `citations.js`: lazy Citation Explorer route, Summon modal, citation exports,
  and foundational works.
- `people.js`: lazy Person Explorer route and supervisor/person profiles.
- `analytics-dashboard.js`: lazy Chart.js dashboard route and non-D3 analytics
  panels.
- `topic-visuals.js`: second-level lazy D3 visualizations for Analytics →
  Visualizations.
- `admin.js`: lazy Admin route, login/MFA, settings, import rules, jobs, cache,
  topic labels, and run history.

When adding a feature, keep first-screen dependencies in `main.js`, `core.js`,
`documents.js`, or `data.js` only when they are required for Document Explorer.
Tab-specific code should expose an idempotent `init*()` function and be loaded
through `main.js`.
