# Browser Code Layout

The browser app is split into ordered classic scripts, loaded by
`public/index.html`. The order matters because the app intentionally shares a
small global state object and top-level functions across files without a build
step.

- `core.js`: DOM references, shared state, formatting helpers, routing, and
  cross-feature document matching helpers.
- `documents.js`: Document Explorer table, detail modal, related documents, and
  per-document citation loading.
- `analytics-dashboard.js`: dashboard charts, word/concept clouds, methodology
  views, and heatmaps.
- `citations.js`: Citation Explorer, Summon modal, citation exports, and
  foundational works.
- `topic-visuals.js`: topic timelines, topic clusters, dendrograms, networks,
  Sankey, and methodology-topic bubbles.
- `people.js`: supervisor and person explorer profiles.
- `data.js`: facet filters, client-side analytics aggregation, data loading, and
  top-level rendering orchestration.
- `admin.js`: login/MFA, settings, import rules, jobs, cache, and run history.
- `events.js`: event binding and startup.

When adding a new feature, prefer adding it to the nearest feature file and
keeping `events.js` as the only place for page-level event wiring.
