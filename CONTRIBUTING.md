# Contributing

This project values code that is readable first, then commented where the reader needs context the code cannot provide on its own. Comments and documentation should help future maintainers understand route contracts, security assumptions, external service quirks, and non-obvious data-processing choices.

## Documentation Standards

- Keep `README.md` focused on setup, deployment, data flow, and user-facing API behavior.
- Document every public Express endpoint that is intended for browser or admin UI use.
- For each documented endpoint, include the HTTP method, path, auth or CSRF requirements, important query/body parameters, response shape, and notable error cases.
- When adding or changing environment variables, update `README.md` and any example env files in the same change.
- When behavior depends on an external service, document the assumption near the integration code and, when user-facing, in `README.md`.
- Prefer examples that match real project usage over abstract examples.

## Express Route Documentation

Route modules should be readable without needing to trace the entire application boot path. Add a short JSDoc block above exported route factories when the factory accepts dependencies or has mixed public/admin behavior.

Good route-factory comments explain:

- What URL group the router owns.
- Which dependencies are injected and why.
- Whether endpoints require admin auth, CSRF, or public guardrails.
- Any caching, background-job, or expensive-computation behavior callers should know about.

Example:

```js
/**
 * Creates the public metrics router.
 *
 * Public requests are capped by configured limits; authenticated admin requests
 * may refresh, recompute, or trigger file enrichment when CSRF is valid.
 * `metricsInflight` deduplicates identical expensive collection requests.
 */
export function createMetricsRouter({ metricsCache, metricsInflight, loadSyncModule }) {
  // ...
}
```

For individual handlers, avoid a comment on every route if the code is already direct. Add comments where a handler performs fallback behavior, starts asynchronous work, intentionally returns `202`, or maps an external API response into local shape.

## Inline Comment Standards

Use inline comments to explain why a choice exists, not what the next line of code literally does.

Good comments:

```js
// Express applies the configured trust-proxy policy to req.ip, so use req.ip
// instead of reading X-Forwarded-For directly.
```

```js
// UBC encodes collection IDs in the Elasticsearch index name; deriving the
// direct PDF URL avoids a slower item-page scrape when the API omits file links.
```

Avoid comments like:

```js
// Create a new router.
const router = Router();

// Return a 404 error.
res.status(404).json({ error: 'Not found' });
```

## What To Comment

Comment these areas consistently:

- Security decisions, including CSRF exceptions, auth checks, cookie behavior, redirect handling, URL allowlists, and proxy trust assumptions.
- External API quirks, including unusual parameter encoding, rate limits, response-shape fallbacks, and compatibility workarounds.
- Cache keys and invalidation rules, especially when keys must match browser defaults or background-job options.
- Background jobs and fire-and-forget operations, including why the route returns before work completes.
- Parsing heuristics, scoring rules, OCR cleanup, citation extraction, and other domain logic where the rule is not obvious from syntax.
- Intentional fallbacks, such as using local cache when Open Collections facets are unavailable.
- Non-obvious test setup, fixture choices, and regression cases.

## What Not To Comment

Do not add comments that merely restate JavaScript, Express, or HTML mechanics. Prefer clearer names or smaller helper functions instead.

Avoid:

- Narrating each line in a simple handler.
- Leaving stale TODOs without an owner or condition for removal.
- Explaining code that could be made obvious with a better function name.
- Large historical notes that belong in commit history or issue discussion.
- Commented-out code.

## JSDoc Guidance

Use JSDoc for exported functions, route factories, middleware, and helpers whose contract is not obvious from their name.

JSDoc is most useful when it documents:

- Accepted input shape.
- Return value or response behavior.
- Side effects, such as writes, cache updates, network calls, or job creation.
- Error behavior.
- Security expectations.

Keep JSDoc concise. It should clarify the contract, not duplicate the implementation.

Example:

```js
/**
 * Requires an authenticated admin session.
 *
 * On success, attaches the authenticated user to `req.user`.
 * Responds with 401 and does not call `next()` when authentication fails.
 */
export function requireAdmin(req, res, next) {
  // ...
}
```

## API And Admin UI Changes

When adding or changing an endpoint:

1. Update or add route documentation.
2. Document auth and CSRF requirements.
3. Document public/admin guardrails and production defaults when relevant.
4. Add comments for non-obvious cache, job, or external API behavior.
5. Update tests when the behavior is important enough that stale docs would mislead a maintainer.

## Frontend Comments

The browser code is split into classic scripts under `public/app`. Use section comments sparingly to orient readers in large files, and prefer function names for local clarity.

Comment frontend code when:

- State is mirrored with backend constants or behavior.
- URL hash or query behavior is intentionally preserved for deep links.
- Sanitization or escaping is needed before rendering external data.
- Client-side analytics intentionally differ from server-side analytics.

## Review Checklist

Before opening a change, check:

- Could a new contributor find the endpoint or behavior in docs?
- Does every security-sensitive exception explain why it is safe?
- Are comments explaining domain decisions rather than JavaScript syntax?
- Did changed environment variables, route params, or response shapes get documented?
- Are old comments still true after the change?
