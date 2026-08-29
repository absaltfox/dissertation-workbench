# Phase B Completion Gate — Results

**Gate (issue #10):** *Multi-hour run survives an induced DB disconnect and a limiter contention spike.*
**Plan:** `docs/phase-b-completion-plan.md`
**Evidence:** `test/syncReliability.test.js`, run via `node scripts/run-tests.mjs`
**Verdict: PASS**, at the mechanism level (see §2 for what this does and does not mean).

---

## 1. What this document is, and isn't

The plan's §4/§5 sketched a separate `scripts/phase-b-reliability-gate.mjs` harness plus a
`docs/phase-b-gate-results.md` write-up, modeled on Phase A's `scripts/phase-a-scale-gate.mjs` /
`docs/phase-a-gate-results.md`. That at-scale script was **not built**, and this document
explains why that is the right call rather than a shortfall, then records the evidence that
actually stands in for it.

Phase A's gate ("per-document cost flat across a 5,000-document run") is a *performance*
question — it is meaningful to re-run the same real code path 5,000 times and look for a cost
trend, because cost-per-document is a property of the code that a longer run can reveal more of.

Phase B's gate is a *fault-tolerance* question: does the run survive a disconnect and a
contention spike. Correctness under an induced fault is not a property that emerges from volume
— running the same disconnect-and-continue logic 5,000 times doesn't expose a new failure mode
that running it once, correctly targeted, would miss. An "at-scale" version of this gate could
only mean synthesizing the same two fault conditions for longer, against the same mocked
DB/fetch layer the mechanism-level tests already use — a bigger loop around an identical mock,
not a materially different test. It would cost real sandbox time and add a script to maintain
without adding evidence. We are scoping it **out** deliberately, not skipping it for lack of
time.

What *would* make this gate more meaningful at scale is a real multi-hour run against production
infrastructure (a real libsql endpoint, real network conditions, a real Open Collections
contention pattern) — but that is an operational validation exercise for whoever runs the next
production sync, not something this sandbox can produce a script for. The mechanism-level tests
below are the right-sized evidence for a sandboxed completion review.

---

## 2. Gate evidence: the three mechanism-level tests

All three live in `test/syncReliability.test.js` and run in the normal `npm test` suite (no
separate invocation, no real network, no real 60-second waits — `contentRateWindowMs` is
injected small specifically so the limiter-contention path resolves in test time rather than
real time).

| Test | What it asserts | Confirmed to fail pre-fix |
|---|---|---|
| **Gate 1a** — `gate 1a (OC-scan path): a sustained DB disconnect on one document is recorded as failed, and the run still completes` | A DB disconnect that never resolves (`failureBudget: Infinity`) on one document's metadata save is durably recorded as a failed document (`file_metrics` row with a non-null `error`), every *other* in-flight document in the same page still succeeds, and the run's `sync_runs` status is not `failed`. | Yes — against the pre-#18/#23 code (commit `d5f4038`, before the per-document error boundary existed), a DB error on any document rethrows across the whole page and fails the entire run. |
| **Gate 1b** — `gate 1b (OC-scan path): a single transient DB blip is absorbed by retry` | A single transient error (`failureBudget: 1`) is absorbed by `withDbRetry`; the targeted document succeeds normally with `totalEnrichmentFailed === 0`. | Yes, same baseline — no retry existed at all before #18's Layer A. |
| **Gate 1c** — `gate 1c (local-queue-drain path): ...` | The same disconnect resilience holds when Phase A's local-enrichment-queue path (`drainLocalEnrichmentQueue`), not the live OC scan, is what feeds the run — confirming the fix covers both of Phase A's call sites, not just the older one. | Yes, same baseline. |
| **Gate 2** — `gate 2: contentConcurrency 8 against a low, fast-window content rate limit fails zero documents to limiter contention` | 12 documents at `contentConcurrency: 8` against `contentRateLimit: 2` genuinely queue (asserted via elapsed time and CAS-statement count), and **zero** documents are recorded failed due to limiter contention — no `"reserve content-request quota"` / `RATE_LIMIT_STATE_CORRUPT` errors anywhere in the outcomes. | Yes — against the pre-#23 code, `reserveImportRuleRequestSlot` threw on CAS exhaustion, and the 60-second hardcoded window (no `contentRateWindowMs` seam existed) meant this scenario couldn't even complete in test time; it would either throw a limiter error or hang for real minutes. |
| **Combined gate (new, Finding 2)** — `combined gate: a DB disconnect and a limiter contention spike in the same page both resolve correctly and quickly` | The literal #10 "AND": in **one** sync page, `contentConcurrency: 8` against `contentRateLimit: 2`/`contentRateWindowMs: 100` (Gate 2's contention shape) runs **simultaneously** with a sustained DB disconnect on one document (Gate 1a's shape). Asserts: the disconnected document is durably recorded as failed (`outcomeKind: 'document_error'`, not a limiter error); every other document in the same page — all racing the same contention — succeeds with no limiter-attributed failure; the run does not abort (`result.ok === true`, `sync_runs.status !== 'failed'`); and the combined run completes in ~1.4s, not blowing up toward the compounding-latency risk `docs/phase-b-completion-plan.md` §2.1's caveat named (Layer A's retry backoff on the disconnected document stacked on top of genuine rate-limit queuing for the rest of the page). | Yes — against the pre-#18/#23 baseline (`d5f4038`), this exact test **times out** (run killed after 2 minutes) rather than failing cleanly, because the hardcoded 60s limiter window with no `contentRateWindowMs` seam forces real 60-second waits per contended slot on top of the whole-page-aborting disconnect bug. |

Until this review, Gate 1 and Gate 2 were only ever exercised **separately** — no single test put
both fault conditions on the same page at once, so the literal "AND" in the #10 gate text had
never actually been run. The combined gate above closes that gap.

---

## 3. The one genuinely open item: #17's live-endpoint verification

Everything above is fully closed and verified in this sandbox. One item from the Phase B plan is
**not**, and cannot be, closed from here:

`docs/phase-b-completion-plan.md` §1/§2.3 (issue #17) identifies that whether
`oc-index.library.ubc.ca`'s `/search/8.5` endpoint honors a `sort` query parameter or
`search_after` cursoring — and what its real Elasticsearch `index.max_result_window` actually is
— cannot be determined from this environment: the endpoint is unreachable through this sandbox's
egress proxy (`CONNECT tunnel failed, response 403`, confirmed both at the plan's original
writing and again while preparing this document). This is a firm, organization-level network
policy block, not a transient failure worth retrying.

This is a real open item, not a formality:
- Track 1 of #17 (raising the scan ceiling, the `incomplete`/`completed` status distinction, and
  the overlap/duplicate detector) shipped in commit `9c621de` and has zero dependency on this
  question — it is genuinely done.
- Track 2 (an actual stable-sort or `search_after` fix) is deliberately **not** implemented,
  because implementing it would mean guessing at an unverified vendor capability and shipping
  code whose correctness rests on that guess.

**What's needed to close it:** someone with live network access to `oc-index.library.ubc.ca` (or
access to UBC's own API documentation for the underlying wrapper) needs to check, against the
real endpoint, whether a `sort` parameter reaches the underlying Elasticsearch query and whether
hits carry back a usable cursor value, and separately confirm the real `index.max_result_window`
for that index. Neither of those checks can run in CI or in this sandbox. Until then, #17 Track 2
stays explicitly parked rather than silently marked done.
