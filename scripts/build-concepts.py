#!/usr/bin/env python3
"""PatternRank-style concept worker.

Runs as an admin worker job. It loads stored dissertation metadata, generates
cheap-gated noun-phrase candidates, ranks candidates with sentence-transformer
similarity against document context, and writes the existing concept artifact
shape back to the web app.
"""

import json
import hashlib
import math
import os
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

MODEL_NAME = os.environ.get("CONCEPT_PATTERNRANK_MODEL", "allenai/specter2_base")
PIPELINE_VERSION = "patternrank-v3"
DB_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "metrics.sqlite")
DAILY_HOUR_LOCAL = 2
MAX_CANDIDATES_PER_DOC = int(os.environ.get("CONCEPT_MAX_CANDIDATES_PER_DOC", "160"))
TOP_CANDIDATES_PER_DOC = int(os.environ.get("CONCEPT_TOP_CANDIDATES_PER_DOC", "12"))
MIN_RANK_SCORE = float(os.environ.get("CONCEPT_PATTERNRANK_MIN_SCORE", "0.28"))
MIN_DOCUMENT_FREQUENCY = max(2, int(os.environ.get("CONCEPT_MIN_DOCUMENT_FREQUENCY", "2")))
CHECKPOINT_BATCH_SIZE = max(10, int(os.environ.get("CONCEPT_CHECKPOINT_BATCH_SIZE", "50")))
MAX_PARTITION_DOCUMENTS = max(100, int(os.environ.get("CONCEPT_PARTITION_MAX_DOCUMENTS", "5000")))
# #21: the automatic partition family groups documents by (degree, year-bucket).
# Decade buckets are the default -- see cohort_year_bucket() below and
# docs/phase-c-completion-plan.md #21 for why: exact-year grouping put the first
# complete global concept dictionary years away at the pre-existing daily cadence,
# and decade coarsening cuts cohort count by roughly the average distinct years per
# degree with no schema change (partition_key hashes the scope, so old per-year
# partitions just age out through the existing retirement path). Set to "year" to
# restore the old exact-year grouping.
CONCEPT_PARTITION_GRANULARITY = os.environ.get("CONCEPT_PARTITION_GRANULARITY", "decade").strip().lower()
if CONCEPT_PARTITION_GRANULARITY not in ("decade", "year"):
    CONCEPT_PARTITION_GRANULARITY = "decade"
# #20: how many concept_partitions rows discover_partition bulk-upserts per
# statement. 9 params/row; 80 rows/statement keeps a batch at 720 params, safely
# under even the conservative pre-3.32 SQLite parameter-count ceiling of 999 (the
# actual limit -- SQLITE_MAX_VARIABLE_NUMBER -- is not queryable through the
# sqlite3/libsql_client APIs this file uses, so this stays a fixed, conservative
# constant rather than something probed at runtime).
PARTITION_WRITE_BATCH_SIZE = max(10, int(os.environ.get("CONCEPT_PARTITION_WRITE_BATCH_SIZE", "80")))
PARTITION_KEY_CHUNK_SIZE = 500
MAX_PARTITION_CONCEPTS = max(100, int(os.environ.get("CONCEPT_PARTITION_MAX_CONCEPTS", "5000")))
MAX_GLOBAL_CONCEPTS = max(MAX_PARTITION_CONCEPTS, int(os.environ.get("CONCEPT_GLOBAL_MAX_CONCEPTS", "50000")))
# A 2-gram is only folded into a containing 3-gram when the pair is well attested;
# otherwise a single stray extension would swallow an independent concept.
VARIANT_EXTENSION_MIN_DOCUMENT_FREQUENCY = max(
    2, int(os.environ.get("CONCEPT_VARIANT_EXTENSION_MIN_DF", "3"))
)
# How many 3-grams one 2-gram may absorb. The extension rule exists to reabsorb
# sliding-window fragments ("critical literacy" / "critical literacy practices"),
# and a phrase with one or two extensions is plausibly exactly that. A phrase with
# a dozen is not a fragment at all -- it is a hub topic whose extensions are
# distinct research areas, and folding them in replaces every specific concept
# with the generic parent, which is the opposite of a discovery aid. Above the
# limit the whole fan-in is left alone rather than an arbitrary subset absorbed:
# picking k of n equally-good extensions would decide by sort order, not evidence.
MAX_VARIANT_EXTENSION_FAN_IN = max(
    1, int(os.environ.get("CONCEPT_VARIANT_EXTENSION_MAX_FAN_IN", "2"))
)
# Hard ceiling on head-prefix comparisons inside one blocking bucket. Blocking already
# keeps clustering linear in practice; this guarantees it even for adversarial inputs.
MAX_BUCKET_COMPARISONS = max(1000, int(os.environ.get("CONCEPT_MAX_BUCKET_COMPARISONS", "50000")))

# Heads that read as the subject of a concept rather than an incidental noun; used only
# to break ties when choosing which member of a variant cluster becomes the canonical.
PREFERRED_CANONICAL_HEADS = {
    "education", "learning", "policy", "leadership", "students", "student",
    "research", "health", "curriculum", "assessment",
}

STOP_WORDS = {
    "about", "after", "again", "against", "among", "also", "been", "before",
    "being", "between", "both", "can", "could", "did", "does", "doing",
    "during", "each", "from", "have", "having", "here", "into", "itself",
    "just", "more", "most", "much", "must", "only", "other", "over",
    "same", "should", "some", "such", "than", "that", "their", "theirs",
    "them", "then", "there", "these", "they", "this", "those", "through",
    "under", "until", "very", "were", "what", "when", "where", "which",
    "while", "with", "within", "without", "would", "your", "yours", "study",
    "research", "thesis", "dissertation", "ubc", "university", "doctoral",
    "doctor", "education",
}

DOMAIN_DICTIONARY = [
    ("higher education", ["post-secondary education", "postsecondary education", "tertiary education", "university education"]),
    ("doctoral education", ["doctor of education", "edd", "doctoral studies"]),
    ("teacher education", ["preservice teacher education", "pre-service teacher education", "initial teacher education"]),
    ("educational leadership", ["school leadership", "leadership in education", "education leadership"]),
    ("educational policy", ["education policy", "policy in education", "educational policymaking"]),
    ("indigenous education", ["first nations education", "aboriginal education", "indigenous pedagogy"]),
    ("decolonization", ["decolonisation", "decolonizing", "decolonising"]),
    ("equity diversity inclusion", ["edi", "equity diversity and inclusion", "diversity equity inclusion"]),
    ("inclusive education", ["inclusion in education", "inclusive pedagogy", "inclusive schooling"]),
    ("curriculum", ["curriculum development", "curricular design", "curricular"]),
    ("assessment", ["student assessment", "learning assessment", "evaluation"]),
    ("professional learning", ["professional development", "teacher professional development", "continuing professional learning"]),
    ("online learning", ["e-learning", "elearning", "digital learning", "remote learning"]),
    ("international students", ["foreign students", "overseas students"]),
    ("mental health", ["mental illness", "psychological wellbeing", "psychological well-being"]),
    ("british columbia", ["bc", "b.c.", "province of british columbia"]),
    ("university of british columbia", ["ubc", "the university of british columbia"]),
    ("doctor of education", ["edd", "ed.d."]),
]

CONNECTOR_TOKENS = {
    "aboard", "about", "above", "across", "after", "against", "along", "among",
    "around", "before", "behind", "below", "beneath", "beside", "between",
    "beyond", "during", "except", "following", "inside", "into", "near",
    "outside", "through", "toward", "towards", "under", "until", "within",
    "without", "because", "whether", "while", "whereas",
}

FRAGMENT_HEADS = {
    "aim", "aims", "area", "areas", "case", "cases", "chapter", "chapters",
    "component", "components", "context", "contexts", "example", "examples",
    "factor", "factors", "finding", "findings", "issue", "issues", "lens",
    "level", "levels", "matter", "matters", "need", "needs", "pattern",
    "patterns", "problem", "problems", "reflection", "reflections", "result",
    "results", "role", "roles", "section", "sections", "theme", "themes",
    "topic", "topics", "view", "views", "way", "ways",
}

FRAGMENT_STARTS = {
    "aim", "aims", "case", "cases", "cross", "finding", "findings", "lens",
    "reflection", "reflections", "result", "results", "role", "roles",
    "theme", "themes", "view", "views",
}

WEAK_HEADS = {
    "understanding", "perspectives", "perspective", "experiences", "experience",
    "making", "sense", "develop", "development", "future", "current", "analysis",
    "approach", "framework", "frameworks", "models", "model", "stories", "story",
    "including", "based", "used", "explores", "examined", "governed", "ensures",
    "requires", "played", "included", "completed", "witnessed", "takes",
    "suggests", "indicates", "ensuring", "involving", "using", "provided",
    "providing", "relied", "operationalized", "similarly", "explored",
}

WEAK_ANYWHERE = {
    "purpose", "deeper", "better", "increase", "making", "including", "people",
    "participants", "interviewees", "transcribed", "audio", "taped", "shared",
    "current", "future", "used", "based", "broad", "complex", "important",
    "necessary", "well", "british", "columbia", "unspecified", "rather", "even",
    "although", "already", "often", "particularly", "significant", "include",
    "resulting", "related", "general", "various",
}

CARDINAL_WORDS = {
    "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
    "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "twenty",
    "thirty", "forty", "fifty", "hundred",
}

KNOWN_LABEL_PHRASES = {
    "case study",
    "cross cultural communication",
    "cross cultural education",
    "cross cultural learning",
    "professional learning",
}


class SqliteClientWrapper:
    def __init__(self, db_path):
        self.conn = sqlite3.connect(db_path)
        self.conn.row_factory = sqlite3.Row

    def execute(self, sql, params=None):
        cursor = self.conn.cursor()
        cursor.execute(sql, tuple(params or ()))

        class ResultSet:
            def __init__(self, cursor):
                self.rows = cursor.fetchall()

        self.conn.commit()
        return ResultSet(cursor)

    def close(self):
        self.conn.close()


def get_db_client(db_path):
    url = os.environ.get("TURSO_DATABASE_URL", "").strip()
    auth_token = os.environ.get("TURSO_AUTH_TOKEN", "").strip()
    if url:
        if url.startswith("libsql://"):
            url = "https://" + url[len("libsql://"):]
        import libsql_client
        print(f"Connecting to remote Turso database: {url}")
        return libsql_client.create_client_sync(url, auth_token=auth_token)
    print(f"Connecting to local SQLite database: {db_path}")
    return SqliteClientWrapper(db_path)


class JobReporter:
    def __init__(self, client, job_id):
        self.client = client
        self.job_id = int(job_id) if job_id else None
        self.tasks = []
        self.task_index = {}

    def append_log(self, text):
        print(text, end="" if text.endswith("\n") else "\n")
        if not self.job_id:
            return
        self.client.execute(
            "UPDATE admin_jobs SET log = COALESCE(log, '') || ? WHERE id = ?",
            [text if text.endswith("\n") else text + "\n", self.job_id],
        )

    def report(self, key, label, status="running", detail=None, counts=None, next_task=None):
        if not self.job_id:
            return
        task = {
            "key": key,
            "label": label,
            "status": status,
            "detail": detail,
            "counts": counts or {},
            "updatedAt": datetime.now(timezone.utc).isoformat(),
        }
        if key in self.task_index:
            self.tasks[self.task_index[key]] = task
        else:
            self.task_index[key] = len(self.tasks)
            self.tasks.append(task)
        current_task = next_task if status == "completed" and next_task else label
        progress = {
            "phase": key,
            "currentTask": current_task,
            "tasks": self.tasks,
            "counts": counts or {},
        }
        now = datetime.now(timezone.utc).isoformat()
        self.client.execute(
            "UPDATE admin_jobs SET progress_json = ?, runner_state = ?, heartbeat_at = ? WHERE id = ?",
            [json.dumps(progress), current_task, now, self.job_id],
        )

    def finish(self, status, result=None, error=None):
        if not self.job_id:
            return
        now = datetime.now(timezone.utc).isoformat()
        self.client.execute(
            "UPDATE admin_jobs SET status = ?, runner_state = ?, result_json = ?, error = ?, finished_at = ?, artifact_token_hash = NULL WHERE id = ?",
            [status, status, json.dumps(result) if result is not None else None, error, now, self.job_id],
        )


def normalize_text(value):
    text = str(value or "").lower()
    text = re.sub(r"[^a-z0-9\s-]", " ", text)
    text = re.sub(r"[_-]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


PHRASE_ROWS = []
for canonical, variants in DOMAIN_DICTIONARY:
    canonical_tokens = normalize_text(canonical).split()
    for variant in [canonical] + variants:
        variant_tokens = normalize_text(variant).split()
        if variant_tokens:
            PHRASE_ROWS.append((variant_tokens, canonical_tokens))
PHRASE_ROWS.sort(key=lambda row: len(row[0]), reverse=True)


def canonicalize_domain_text(value):
    words = normalize_text(value).split()
    out = []
    i = 0
    while i < len(words):
        matched = None
        for variant_tokens, canonical_tokens in PHRASE_ROWS:
            if words[i:i + len(variant_tokens)] == variant_tokens:
                matched = canonical_tokens
                break
        if matched:
            out.extend(matched)
            i += len(variant_tokens)
        else:
            out.append(words[i])
            i += 1
    return " ".join(out)


def split_words(text):
    return canonicalize_domain_text(text).split()


def valid_label_expression(phrase):
    phrase = normalize_text(phrase)
    if phrase in KNOWN_LABEL_PHRASES:
        return True
    tokens = phrase.split()
    if len(tokens) < 2 or len(tokens) > 3:
        return False
    if len(set(tokens)) < len(tokens):
        return False
    if any(t in CONNECTOR_TOKENS or t in CARDINAL_WORDS for t in tokens):
        return False
    if tokens[-1] in FRAGMENT_HEADS or tokens[-1] in WEAK_HEADS:
        return False
    if tokens[0] in FRAGMENT_STARTS:
        return False
    if any(t in {"lens", "reflection", "reflections"} for t in tokens):
        return False
    if any(t in WEAK_ANYWHERE for t in tokens):
        return False
    return True


def is_skippable_token(token):
    return (
        len(token) < 4
        or token in STOP_WORDS
        or token in CARDINAL_WORDS
        or re.match(r"^\d{4}[a-z]?$", token)
        or re.match(r"^\d+$", token)
    )


def doc_segments(meta):
    title_segments = [s.strip() for s in re.split(r"[:;,]", meta.get("title") or "") if s.strip()]
    abstract_segments = [s.strip() for s in re.split(r"[/,]", meta.get("abstract") or meta.get("description") or "") if s.strip()]
    subjects = meta.get("subjects") or meta.get("subject") or []
    if isinstance(subjects, str):
        subjects = [subjects]
    subject_segments = [s.strip() for s in "/".join(subjects).split("/") if s.strip()]
    return (
        [("title", s) for s in title_segments]
        + [("abstract", s) for s in abstract_segments]
        + [("subject", s) for s in subject_segments]
    )


def document_text(meta):
    subjects = meta.get("subjects") or meta.get("subject") or []
    if isinstance(subjects, str):
        subjects = [subjects]
    return " ".join([
        str(meta.get("title") or ""),
        str(meta.get("abstract") or meta.get("description") or ""),
        " ".join(str(s) for s in subjects),
    ]).strip()


def extract_candidates(meta):
    candidates = set()
    for _kind, segment in doc_segments(meta):
        words = split_words(segment)
        for n in (2, 3):
            for i in range(0, len(words) - n + 1):
                window = words[i:i + n]
                if any(is_skippable_token(w) for w in window):
                    continue
                phrase = " ".join(window)
                if not valid_label_expression(phrase):
                    continue
                candidates.add(phrase)
                if len(candidates) >= MAX_CANDIDATES_PER_DOC:
                    return candidates
    return candidates


def cosine(a, b):
    denom = math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(x * x for x in b))
    if not denom:
        return 0.0
    return sum(x * y for x, y in zip(a, b)) / denom


def stem_for_similarity(token):
    """Strip common English plural suffixes for comparison only.

    Mirrors ``stemForSim`` in src/conceptsPipeline.js -- the two functions apply the
    identical plural-stripping rule, byte for byte. That is the only clustering
    primitive the two pipelines still share: this worker's cluster_phrases() uses
    blocking rules R1/R2/R3 with an enforced variant-extension fan-in cap, which
    conceptsPipeline.js's clustering (an O(P^2) all-pairs threshold with no fan-in
    cap) does not implement. conceptsPipeline.js's own clustering path is dead code
    in production (see #34) -- only its persistence helpers, getConceptPipelineStatus
    and persistConceptArtifact, are still live.
    """
    if len(token) > 5 and token.endswith("ies"):
        return token[:-3] + "y"
    if len(token) > 4 and token.endswith("s") and not token.endswith("ss"):
        return token[:-1]
    return token


def phrase_stems(phrase):
    return tuple(stem_for_similarity(token) for token in phrase.split())


def classify_variant_rule(canonical, phrase):
    """Classify which cluster_phrases rule could connect ``phrase`` to ``canonical``.

    Purely structural, derived from the two strings alone -- correct regardless of
    which pass produced them (fresh partition build, merge, or a legacy artifact
    that predates this classification) because R1 and R2 can only ever connect
    phrases with identical *token counts* (R1 buckets on a stemmed-token frozenset,
    R2 buckets on a stemmed-modifier tuple, both keyed by structures whose size is
    the token count) while R3 is the only rule that connects a 2-gram to a 3-gram.
    So a token-count mismatch is an exact, cheap R3 test; among same-length pairs,
    an identical stemmed token set is R1 and anything else is R2. Used both to tag
    freshly-built variants (see build_variant_map) and, at merge time, to classify
    variants read back from any artifact -- old (bare-string, no tag) or new
    (tagged) alike -- without trusting a possibly-stale stored value.
    """
    canonical_stems = phrase_stems(canonical)
    variant_stems = phrase_stems(phrase)
    if len(canonical_stems) != len(variant_stems):
        return "R3"
    if frozenset(canonical_stems) == frozenset(variant_stems):
        return "R1"
    return "R2"


class DisjointSet:
    """Union-find with path compression; deterministic and order independent."""

    def __init__(self):
        self.parent = {}

    def add(self, item):
        self.parent.setdefault(item, item)

    def find(self, item):
        root = item
        while self.parent[root] != root:
            root = self.parent[root]
        while self.parent[item] != root:
            self.parent[item], item = root, self.parent[item]
        return root

    def union(self, left, right):
        self.add(left)
        self.add(right)
        left_root = self.find(left)
        right_root = self.find(right)
        if left_root == right_root:
            return
        # Attach the lexicographically larger root to the smaller one so the forest
        # shape — and therefore every downstream iteration order — is reproducible.
        if left_root > right_root:
            left_root, right_root = right_root, left_root
        self.parent[right_root] = left_root

    def components(self):
        grouped = {}
        for item in self.parent:
            grouped.setdefault(self.find(item), []).append(item)
        return [sorted(members) for _, members in sorted(grouped.items())]


def cluster_phrases(phrases, document_frequency):
    """Group near-duplicate phrases into variant clusters.

    Blocking, not all-pairs. Candidate phrases are 2-3 distinct tokens (enforced by
    ``valid_label_expression``), which bounds the reachable Jaccard values and lets
    every clustering rule be expressed as an exact bucket lookup:

      R1 equivalence  - identical stemmed token *sets*. Catches plural forms
                        ("learning community" / "learning communities") and token
                        reorderings ("policy education" / "education policy").
                        Bucket key: frozenset of stemmed tokens.
      R2 head form    - same token count, identical stemmed modifiers in order, and
                        one head stem is a proper prefix of the other (both >= 5
                        characters). Catches "educational leader" / "educational
                        leadership". Bucket key: the stemmed modifier tuple.
      R3 extension    - a 2-gram whose stems are the first two stems of a 3-gram,
                        when the pair is attested by at least
                        VARIANT_EXTENSION_MIN_DOCUMENT_FREQUENCY documents. Catches
                        "online learning" / "online learning environments".
                        Bucket key: the 2-gram's stem pair.

    Each rule is O(1) lookup or an output-sensitive scan, so total work is linear in
    the phrase count plus the number of variant pairs actually found. Returns
    ``(clusters, telemetry)``: the clusters (lists of phrases), each sorted, in
    deterministic order, and a dict recording how much of R2 the comparison budget
    cut short.
    """
    forest = DisjointSet()
    for phrase in phrases:
        forest.add(phrase)

    equivalence_buckets = {}
    modifier_buckets = {}
    bigram_stems = {}
    trigrams = []
    for phrase in sorted(phrases):
        stems = phrase_stems(phrase)
        if not stems:
            continue
        equivalence_buckets.setdefault(frozenset(stems), []).append(phrase)
        if len(stems) >= 2:
            modifier_buckets.setdefault(stems[:-1], {}).setdefault(stems[-1], []).append(phrase)
        if len(stems) == 2:
            bigram_stems.setdefault(stems, []).append(phrase)
        elif len(stems) == 3:
            trigrams.append((phrase, stems))

    # R1: every phrase in a bucket shares the same stemmed token set.
    for members in equivalence_buckets.values():
        for other in members[1:]:
            forest.union(members[0], other)

    # R2: inside one modifier bucket, sort the head stems. If head A is a prefix of
    # head B then every string between them also carries that prefix, so the matches
    # for A form a contiguous run and the forward scan can stop at the first miss.
    # MAX_BUCKET_COMPARISONS is a safety valve against a pathological bucket, but
    # tripping it discards legitimate merges: the current head is abandoned mid-run
    # and so is every head after it. Because ``ordered`` is sorted, the casualties
    # are always the lexicographically later heads, which makes the loss structural
    # rather than random and lets clustering drift between incremental rebuilds.
    # Count it so an operator can see clustering was truncated and raise the budget.
    truncated_buckets = 0
    truncated_heads = 0
    for heads in modifier_buckets.values():
        ordered = sorted(heads)
        comparisons = 0
        for index, head in enumerate(ordered):
            if len(head) < 5:
                continue
            # Walk by position. ``ordered[index + 1:]`` copied the whole bucket tail
            # for every head before comparing anything -- work the comparison budget
            # cannot see, so it cannot bound it either (60k phrases in one bucket
            # with no prefix relations spent ~15s purely copying).
            for offset in range(index + 1, len(ordered)):
                comparisons += 1
                if comparisons > MAX_BUCKET_COMPARISONS:
                    break
                other = ordered[offset]
                if not other.startswith(head):
                    break
                forest.union(heads[head][0], heads[other][0])
            if comparisons > MAX_BUCKET_COMPARISONS:
                truncated_buckets += 1
                truncated_heads += len(ordered) - index
                break

    # R3: a 3-gram extends a 2-gram when the 2-gram's stems are its leading stems.
    # Collect the eligible edges before applying any of them: the fan-in decision
    # needs to see a 2-gram's whole extension set, and unioning as we go would
    # merge the first arrivals before we know how many there are.
    extensions = {}
    for phrase, stems in trigrams:
        for shorter in bigram_stems.get(stems[:2], []):
            attested = max(document_frequency.get(phrase, 0), document_frequency.get(shorter, 0))
            if attested >= VARIANT_EXTENSION_MIN_DOCUMENT_FREQUENCY:
                extensions.setdefault(shorter, []).append(phrase)

    # Fan-in is measured in distinct concepts, not surface forms. extract_candidates
    # is a raw sliding window with no plural normalisation, so a real corpus yields
    # "critical literacy practice" AND "critical literacy practices" as separate
    # candidates -- which R1 has already merged into one component by this point.
    # Counting surface forms would score that as two extensions and make a limit of
    # two mean "at most one distinct extension", withholding exactly the fragment
    # merges this rule exists to make. Roots are snapshotted before the apply loop
    # so an earlier union cannot lower a later hub's count and make the outcome
    # depend on the (deterministic, but arbitrary) iteration order.
    roots_before = {phrase: forest.find(phrase) for phrase in extensions}
    for absorbed in extensions.values():
        for phrase in absorbed:
            roots_before.setdefault(phrase, forest.find(phrase))

    # `extensions` above is keyed by the literal surface bigram, but two distinct
    # surface forms that co-stem (e.g. "student outcome" / "student outcomes") are
    # already unioned by R1 by this point and so share one root -- meaning both keys
    # independently hold the *same* absorbed trigram set for what is logically one
    # hub. Grouping by root here, and merging each root's absorbed phrases with set
    # union rather than list concatenation (concatenation would just double-count
    # the shared trigrams under a different name), collapses that back to exactly
    # one fan-in decision and one counter increment per hub, no matter how many
    # surface forms it has (#35) -- verified by reproduction: keying by root while
    # still concatenating gives the same doubled Edges=8 the surface-form keying
    # did; only deduplicating the absorbed set gives the true Hubs=1/Edges=4.
    extensions_by_root = {}
    hub_repr = {}
    for shorter, absorbed in extensions.items():
        root = roots_before[shorter]
        extensions_by_root.setdefault(root, set()).update(absorbed)
        # Lexicographically smallest surface form, matching DisjointSet.components()'s
        # own sort convention, so operators see one concrete, readable phrase per hub.
        hub_repr[root] = min(hub_repr.get(root, shorter), shorter)

    extension_hubs_skipped = 0
    extension_edges_skipped = 0
    skipped_hub_sample = []
    for root in sorted(extensions_by_root, key=lambda item: hub_repr[item]):
        absorbed = extensions_by_root[root]
        distinct = {roots_before[phrase] for phrase in absorbed} - {root}
        if len(distinct) > MAX_VARIANT_EXTENSION_FAN_IN:
            extension_hubs_skipped += 1
            extension_edges_skipped += len(absorbed)
            if len(skipped_hub_sample) < 5:
                skipped_hub_sample.append(hub_repr[root])
            continue
        for phrase in absorbed:
            forest.union(root, phrase)

    return forest.components(), {
        "truncatedBuckets": truncated_buckets,
        "truncatedHeads": truncated_heads,
        "comparisonBudget": MAX_BUCKET_COMPARISONS,
        "extensionHubsSkipped": extension_hubs_skipped,
        "extensionEdgesSkipped": extension_edges_skipped,
        "extensionFanInLimit": MAX_VARIANT_EXTENSION_FAN_IN,
        "extensionHubsSkippedSample": skipped_hub_sample,
    }


def pick_canonical(cluster, document_frequency):
    """Choose the cluster member that represents it. Ported from pickCanonical()."""
    def sort_key(phrase):
        tokens = phrase.split()
        head_bonus = 2 if tokens and tokens[-1] in PREFERRED_CANONICAL_HEADS else 0
        length_score = 1 if len(tokens) == 2 else 0
        score = (document_frequency.get(phrase, 0) * 100) + (head_bonus * 10) + length_score
        # Ties fall back to the shorter phrase, then lexicographic order, so the
        # winner never depends on iteration order.
        return (-score, len(phrase), phrase)

    return min(cluster, key=sort_key)


def build_variant_map(concepts, doc_freq_for=None):
    """Project concepts[].variants into the flat map the JS consumer resolves through.

    Built from the *final* concept list so no variant can point at a canonical that
    was dropped by a max-concept cut-off, and so no surviving canonical also appears
    as a variant key. That second property matters: src/metrics.js resolves with
    ``variantMap[term] || (canonicalSet.has(term) ? term : null)``, so a canonical
    that leaked into the map would be silently redirected away from its own entry.

    Also attaches two additive, non-breaking per-concept fields alongside the
    unchanged ``variants`` string list -- ``variantRules`` (phrase -> "R1"|"R2"|"R3",
    via classify_variant_rule) and ``variantDocFreq`` (phrase -> that phrase's own
    document frequency, from ``doc_freq_for``, independent of the cluster's combined
    docFreq). Both exist for #31's merge-time fan-in re-check: it needs to know which
    variant edges are extension (R3, fan-in-limited) edges, and needs a phrase's own
    frequency to give a cross-shard-orphaned extension an honest standalone concept
    if the merge ends up withholding it from its shard's hub. Deliberately additive
    (not a replacement of ``variants``) so every existing reader of the plain string
    list -- src/metrics.js, this file's own assert_alias_invariants, the test suite --
    keeps working unchanged; only merge_partition_artifacts's new fan-in re-check
    (and, best-effort, legacy artifacts lacking these fields) needs to look them up.
    """
    doc_freq_for = doc_freq_for or (lambda _phrase: 0)
    canonicals = {concept["canonical"] for concept in concepts}
    variant_to_canonical = {}
    for concept in concepts:
        canonical = concept["canonical"]
        kept = []
        for variant in concept.get("variants") or []:
            if variant == canonical or variant in canonicals:
                continue
            if variant in variant_to_canonical:
                # Deterministic: the lexicographically smaller canonical keeps the variant.
                if variant_to_canonical[variant] <= canonical:
                    continue
            variant_to_canonical[variant] = canonical
            kept.append(variant)
        concept["variants"] = sorted(kept)
    # A variant may have lost its owner to the tie-break above; drop it from that
    # concept so concepts[].variants and the map stay in exact agreement.
    for concept in concepts:
        canonical = concept["canonical"]
        final_variants = sorted(
            variant for variant in concept["variants"]
            if variant_to_canonical.get(variant) == canonical
        )
        concept["variants"] = final_variants
        concept["variantRules"] = {
            variant: classify_variant_rule(canonical, variant) for variant in final_variants
        }
        concept["variantDocFreq"] = {
            variant: int(doc_freq_for(variant) or 0) for variant in final_variants
        }
    return variant_to_canonical


def assert_alias_invariants(artifact, context):
    """Fail loudly if the alias map, the concept variants and stats.aliases disagree.

    This is the guard against silently shipping an empty map again: the three
    representations of the same clustering are cross-checked before publication.
    """
    variant_to_canonical = artifact.get("variantToCanonical")
    if not isinstance(variant_to_canonical, dict):
        raise ValueError(f"{context}: variantToCanonical must be an object.")
    reported = artifact.get("stats", {}).get("aliases")
    if reported != len(variant_to_canonical):
        raise ValueError(
            f"{context}: stats.aliases={reported} disagrees with "
            f"{len(variant_to_canonical)} variantToCanonical entries."
        )
    concepts = artifact.get("concepts", [])
    canonicals = {concept["canonical"] for concept in concepts}
    projected = {}
    for concept in concepts:
        for variant in concept.get("variants") or []:
            projected[variant] = concept["canonical"]
    if projected != variant_to_canonical:
        raise ValueError(
            f"{context}: variantToCanonical does not match concepts[].variants "
            f"({len(projected)} projected vs {len(variant_to_canonical)} mapped)."
        )
    for variant, canonical in variant_to_canonical.items():
        if canonical not in canonicals:
            raise ValueError(f"{context}: variant '{variant}' maps to missing canonical '{canonical}'.")
        if variant in canonicals:
            raise ValueError(f"{context}: '{variant}' is both a canonical and a variant key.")
    return artifact


def assert_document_frequency_invariants(artifact, context):
    """Fail loudly if any concept claims more documents than the corpus holds.

    docFreq is a count of distinct documents, so it can never exceed the document
    total, and idf = log((N + 1) / (df + 1)) can therefore never be negative. A
    negative idf is not merely odd: src/metrics.js multiplies it by the mention
    count, so the concept scores below the assignment gate and disappears from
    document assignment entirely. Catch it here rather than in the dashboard.
    """
    total_docs = int(artifact.get("stats", {}).get("documents", 0) or 0)
    for concept in artifact.get("concepts", []):
        doc_freq = int(concept.get("docFreq", 0) or 0)
        idf = float(concept.get("idf", 0) or 0)
        if doc_freq > total_docs:
            raise ValueError(
                f"{context}: concept '{concept.get('canonical')}' claims docFreq={doc_freq} "
                f"across only {total_docs} documents."
            )
        if idf < 0:
            raise ValueError(
                f"{context}: concept '{concept.get('canonical')}' has negative idf={idf}."
            )
    return artifact


def artifact_base_url():
    if os.environ.get("WORKER_ARTIFACT_BASE_URL"):
        return os.environ["WORKER_ARTIFACT_BASE_URL"].rstrip("/")
    if os.environ.get("FLY_APP_NAME"):
        port = os.environ.get("PORT") or "3000"
        return f"http://{os.environ['FLY_APP_NAME']}.internal:{port}"
    port = os.environ.get("PORT") or "3000"
    return f"http://127.0.0.1:{port}"


def upload_concept_artifact(artifact):
    job_id = os.environ.get("ADMIN_JOB_ID")
    token = os.environ.get("ADMIN_JOB_ARTIFACT_TOKEN")
    if not job_id or not token:
        data_dir = Path(os.environ.get("APP_DATA_DIR") or Path.cwd() / "data")
        concepts_dir = data_dir / "concepts"
        concepts_dir.mkdir(parents=True, exist_ok=True)
        def atomic_write_json(target, value):
            temporary = target.with_name(f".{target.name}.{os.getpid()}.tmp")
            try:
                temporary.write_text(json.dumps(value, indent=2), encoding="utf-8")
                os.replace(temporary, target)
            finally:
                temporary.unlink(missing_ok=True)

        atomic_write_json(concepts_dir / "latest.json", artifact)
        status = {
            "status": "idle",
            "trigger": "script",
            "lastRunAt": artifact["generatedAt"],
            "lastSuccessAt": artifact["generatedAt"],
            "message": f"PatternRank concept rebuild completed ({artifact['stats']['concepts']} concepts).",
            "stats": artifact["stats"],
        }
        atomic_write_json(concepts_dir / "status.json", status)
        return {"ok": True, "local": True}

    url = f"{artifact_base_url()}/api/internal/jobs/{job_id}/artifacts/concepts/latest"
    req = urllib.request.Request(
        url,
        data=json.dumps(artifact).encode("utf-8"),
        method="PUT",
        headers={
            "authorization": f"Bearer {token}",
            "content-type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=60) as res:
        return json.loads(res.read().decode("utf-8"))


def claim_job(client, job_id):
    if not job_id:
        return
    now = datetime.now(timezone.utc).isoformat()
    client.execute(
        "UPDATE admin_jobs SET claimed_at = COALESCE(claimed_at, ?), runner_state = 'running', heartbeat_at = ? WHERE id = ? AND status = 'running'",
        [now, now, int(job_id)],
    )


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def ensure_incremental_schema(client):
    statements = [
        """CREATE TABLE IF NOT EXISTS concept_partitions (
          partition_key TEXT PRIMARY KEY, scope_json TEXT NOT NULL,
          priority INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL DEFAULT 'pending', source_document_count INTEGER NOT NULL DEFAULT 0,
          source_updated_at TEXT, checkpoint_json TEXT, artifact_version INTEGER NOT NULL DEFAULT 0,
          last_started_at TEXT, last_completed_at TEXT, error TEXT, updated_at TEXT NOT NULL
        )""",
        """CREATE TABLE IF NOT EXISTS concept_document_state (
          partition_key TEXT NOT NULL, doc_id TEXT NOT NULL, content_checksum TEXT NOT NULL,
          candidates_json TEXT NOT NULL, embedding_json TEXT NOT NULL, model_name TEXT NOT NULL,
          processed_at TEXT NOT NULL, PRIMARY KEY (partition_key, doc_id)
        )""",
        """CREATE TABLE IF NOT EXISTS concept_phrase_embeddings (
          model_name TEXT NOT NULL, phrase TEXT NOT NULL, embedding_json TEXT NOT NULL,
          updated_at TEXT NOT NULL, PRIMARY KEY (model_name, phrase)
        )""",
        """CREATE TABLE IF NOT EXISTS concept_partition_artifacts (
          partition_key TEXT NOT NULL, version INTEGER NOT NULL, artifact_json TEXT NOT NULL,
          document_count INTEGER NOT NULL, created_at TEXT NOT NULL,
          PRIMARY KEY (partition_key, version)
        )""",
        """CREATE TABLE IF NOT EXISTS concept_partition_candidates (
          partition_key TEXT NOT NULL, phrase TEXT NOT NULL,
          document_frequency INTEGER NOT NULL,
          PRIMARY KEY (partition_key, phrase)
        )""",
        """CREATE TABLE IF NOT EXISTS concept_publication_state (
          id INTEGER PRIMARY KEY, published_signature TEXT,
          published_at TEXT
        )""",
    ]
    for statement in statements:
        client.execute(statement)
    # #22: partition dirty-detection keys on a content fingerprint (see
    # compute_cohort_content_fingerprints) instead of source_updated_at, which any
    # enrichment pass bumps regardless of whether title/abstract/subjects changed.
    _ensure_column(client, "concept_partitions", "content_fingerprint", "TEXT")


def _ensure_column(client, table, column, sql_type):
    """Idempotently add a column to an existing table.

    ensure_incremental_schema only ever does CREATE TABLE IF NOT EXISTS -- there is
    no ALTER-a-column-in idiom in this file yet (unlike src/db.js's tryExec pattern
    for indexes/columns elsewhere in the app). SQLite and libsql both raise on a
    duplicate column, so the guard is a plain try/except rather than an
    information_schema probe, keeping this portable across the local sqlite3 module
    used in tests and the remote libsql client used against Turso in production.
    """
    try:
        client.execute(f"ALTER TABLE {table} ADD COLUMN {column} {sql_type}")
    except Exception as exc:
        message = str(exc).lower()
        if "duplicate column" in message or "already exists" in message:
            return
        raise


def load_job_params(client, job_id):
    if not job_id:
        return {}
    rows = client.execute("SELECT params_json FROM admin_jobs WHERE id = ?", [int(job_id)]).rows
    if not rows or not rows[0]["params_json"]:
        return {}
    try:
        return json.loads(rows[0]["params_json"])
    except Exception:
        return {}


def normalized_scope(raw=None):
    raw = raw if isinstance(raw, dict) else {}
    filters = raw.get("filters") if isinstance(raw.get("filters"), dict) else raw
    scope = {
        "syncKey": str(raw.get("syncKey") or "").strip(),
        "degree": str(filters.get("degree") or "").strip(),
        "program": str(filters.get("program") or "").strip(),
        "affiliation": str(filters.get("affiliation") or "").strip(),
        "yearFrom": int(raw["yearFrom"]) if str(raw.get("yearFrom") or "").isdigit() else None,
        "yearTo": int(raw["yearTo"]) if str(raw.get("yearTo") or "").isdigit() else None,
        "yearMissing": bool(raw.get("yearMissing")),
    }
    return {key: value for key, value in scope.items() if value not in ("", None, False)}


def partition_key(scope, namespace="automatic"):
    encoded = json.dumps({"namespace": namespace, "scope": scope}, sort_keys=True, separators=(",", ":"))
    label = scope.get("degree") or scope.get("syncKey") or "corpus"
    decade = scope.get("yearFrom")
    readable = re.sub(r"[^a-z0-9]+", "-", str(label).lower()).strip("-")[:48] or "corpus"
    if decade is not None:
        readable += f"-{decade}s"
    prefix = "custom" if namespace == "custom" else "auto"
    return f"{prefix}-{readable}-{hashlib.sha256(encoded.encode('utf-8')).hexdigest()[:12]}"


def scope_where(scope, alias="d"):
    clauses = []
    params = []
    for key, column in (("syncKey", "sync_key"), ("degree", "degree"), ("program", "program")):
        if scope.get(key):
            clauses.append(f"{alias}.{column} = ?")
            params.append(scope[key])
    if scope.get("yearFrom") is not None:
        clauses.append(f"{alias}.year >= ?")
        params.append(scope["yearFrom"])
    if scope.get("yearTo") is not None:
        clauses.append(f"{alias}.year <= ?")
        params.append(scope["yearTo"])
    if scope.get("yearMissing"):
        clauses.append(f"COALESCE({alias}.year, 0) <= 0")
    if scope.get("affiliation"):
        clauses.append(
            f"EXISTS (SELECT 1 FROM json_each({alias}.metadata_json, '$.affiliation') affiliation "
            "WHERE lower(trim(CAST(affiliation.value AS TEXT))) = lower(?))"
        )
        params.append(scope["affiliation"])
    return (" WHERE " + " AND ".join(clauses)) if clauses else "", params


def cohort_year_bucket(year):
    """Coarsen a document year into the automatic-partition grouping key (#21)."""
    year = int(year or 0)
    if year <= 0:
        return 0
    if CONCEPT_PARTITION_GRANULARITY == "year":
        return year
    return (year // 10) * 10


def _year_bucket_sql():
    """SQL expression computing the same bucket cohort_year_bucket() computes in
    Python, so the automatic GROUP BY (one round trip) can bucket server-side
    instead of pulling every document's raw year back to bucket it here."""
    if CONCEPT_PARTITION_GRANULARITY == "year":
        return "COALESCE(year, 0)"
    return "(CASE WHEN COALESCE(year, 0) <= 0 THEN 0 ELSE (COALESCE(year, 0) / 10) * 10 END)"


def _cohort_scope_from_bucket(degree, bucket):
    scope = {}
    if degree:
        scope["degree"] = degree
    bucket = int(bucket or 0)
    if bucket > 0:
        scope["yearFrom"] = bucket
        scope["yearTo"] = bucket if CONCEPT_PARTITION_GRANULARITY == "year" else bucket + 9
    else:
        scope["yearMissing"] = True
    return scope


def compute_content_fingerprint(doc_fields):
    """sha256 over a cohort's concept-relevant fields only -- title, abstract (or
    description), subjects, the same fields document_text()/doc_segments() actually
    read -- sorted by doc_id so row order never affects the result (#22). Comparing
    this instead of source_updated_at is the point of the fix: saveDocumentMetadata
    (src/db.js) bumps updated_at on every write regardless of whether any of these
    fields changed, and Phase B's runEnrichmentBatch (src/sync.js) calls it twice
    per document per enrichment pass, so a plain timestamp compare re-marks a
    cohort dirty on every enrichment run even when nothing concept-relevant moved.
    """
    parts = sorted(
        f"{doc_id}\x1f{title or ''}\x1f{abstract or ''}\x1f{subjects or ''}"
        for doc_id, title, abstract, subjects in doc_fields
    )
    return hashlib.sha256("\x1e".join(parts).encode("utf-8")).hexdigest()


def fetch_cohort_content_fingerprints(client):
    """One bulk per-document projection (json_extract, not an ordered GROUP_CONCAT --
    the local sqlite3 module supports SQLite 3.44+'s ordered aggregate, but whether
    Turso's libsql engine does cannot be verified without a live Turso connection,
    and json_extract is a much older, more universally-supported feature), grouped
    in Python into the same (degree, year-bucket) cohorts the automatic GROUP BY
    query above uses, and hashed into one content fingerprint per cohort.
    """
    rows = client.execute(
        """SELECT doc_id, COALESCE(degree, '') AS degree, COALESCE(year, 0) AS year,
                  json_extract(metadata_json, '$.title') AS title,
                  COALESCE(json_extract(metadata_json, '$.abstract'),
                           json_extract(metadata_json, '$.description')) AS abstract,
                  json_extract(metadata_json, '$.subjects') AS subjects
           FROM documents"""
    ).rows
    grouped = {}
    for row in rows:
        cohort_key = (row["degree"] or "", cohort_year_bucket(row["year"]))
        grouped.setdefault(cohort_key, []).append(
            (row["doc_id"], row["title"], row["abstract"], row["subjects"])
        )
    return {cohort_key: compute_content_fingerprint(fields) for cohort_key, fields in grouped.items()}


def fetch_scope_content_fingerprint(client, scope):
    """Same fingerprint as fetch_cohort_content_fingerprints, scoped to one explicit
    (non-automatic) partition scope -- kept as a single scoped query, matching the
    explicit-scope path's existing once-per-job (not per-cohort) COUNT query."""
    where, args = scope_where(scope)
    rows = client.execute(
        f"""SELECT d.doc_id AS doc_id,
                   json_extract(d.metadata_json, '$.title') AS title,
                   COALESCE(json_extract(d.metadata_json, '$.abstract'),
                            json_extract(d.metadata_json, '$.description')) AS abstract,
                   json_extract(d.metadata_json, '$.subjects') AS subjects
            FROM documents d{where}""",
        args,
    ).rows
    fields = [(row["doc_id"], row["title"], row["abstract"], row["subjects"]) for row in rows]
    return compute_content_fingerprint(fields)


def _upsert_partition_rows_bulk(client, rows):
    """Bulk-upsert concept_partitions rows -- only the ones discover_partition found
    to have actually changed this pass -- chunked at PARTITION_WRITE_BATCH_SIZE.
    This is #20's fix: a first-ever pass over K fresh automatic cohorts costs
    O(K / batch_size) statements here, not O(K); a rerun with nothing changed calls
    this with an empty list and costs zero.
    """
    if not rows:
        return
    for start in range(0, len(rows), PARTITION_WRITE_BATCH_SIZE):
        chunk = rows[start:start + PARTITION_WRITE_BATCH_SIZE]
        placeholders = ",".join(["(?, ?, ?, ?, ?, ?, ?, ?, ?)"] * len(chunk))
        params = []
        for row in chunk:
            params.extend(row)
        client.execute(
            f"""INSERT INTO concept_partitions (
                  partition_key, scope_json, priority, enabled, status, source_document_count,
                  source_updated_at, content_fingerprint, updated_at
                ) VALUES {placeholders}
                ON CONFLICT(partition_key) DO UPDATE SET
                  scope_json = excluded.scope_json,
                  priority = MAX(concept_partitions.priority, excluded.priority),
                  enabled = excluded.enabled,
                  source_document_count = excluded.source_document_count,
                  source_updated_at = excluded.source_updated_at,
                  content_fingerprint = excluded.content_fingerprint,
                  status = excluded.status,
                  updated_at = excluded.updated_at""",
            params,
        )


def discover_partition(client, requested_scope=None, priority=0, force=False):
    """Select the highest-priority changed partition, and persist scheduling state
    for every candidate cohort.

    #20 fix: the automatic path used to issue 3 statements per candidate cohort --
    a per-cohort ``concept_partitions`` lookup, a per-cohort COUNT/MAX that
    recomputes exactly what the GROUP BY summary below already returned for that
    cohort, and an unconditional upsert even when nothing changed. That made every
    run cost 3x the automatic cohort count in round trips, even when nothing in the
    corpus changed anywhere. Fixed by: (a) using the GROUP BY summary rows directly
    for document_count/source_updated_at on the automatic path -- no redundant
    per-cohort COUNT; (b) one bulk ``concept_partitions`` fetch, indexed in memory,
    instead of a per-cohort lookup; (c) writing only cohorts whose persisted state
    actually changed this pass (see the unchanged-checks below), via one chunked
    bulk upsert, plus retirement computed as a set difference over data already in
    memory instead of relying on an unconditional updated_at bump to mark "seen".
    The explicit-scope path is untouched: one job, one scope, a fresh COUNT is
    already O(1) and legitimately needs current data.

    #21: the automatic family's GROUP BY key is a (degree, year-bucket) cohort --
    see cohort_year_bucket()/_year_bucket_sql() for the decade-vs-year grouping.

    #22: "dirty" is decided by a content fingerprint of concept-relevant fields
    (compute_content_fingerprint), not source_updated_at, which any enrichment
    pass bumps regardless of whether title/abstract/subjects actually changed.
    """
    requested_scope = normalized_scope(requested_scope)
    explicit_scope = bool(requested_scope)
    now = utc_now()

    if explicit_scope:
        scope = requested_scope
        key = partition_key(scope, "custom")
        where, args = scope_where(scope)
        summary_rows = client.execute(
            f"SELECT COUNT(*) AS document_count, MAX(updated_at) AS source_updated_at FROM documents d{where}",
            args,
        ).rows
        summary = summary_rows[0]
        count = int(summary["document_count"] or 0)
        cohorts = []
        if count:
            cohorts.append({
                "scope": scope, "key": key, "count": count,
                "sourceUpdatedAt": summary["source_updated_at"],
                "fingerprint": fetch_scope_content_fingerprint(client, scope),
            })
        existing_rows = client.execute("SELECT * FROM concept_partitions WHERE partition_key = ?", [key]).rows
        existing_by_key = {key: existing_rows[0]} if existing_rows else {}
    else:
        bucket_sql = _year_bucket_sql()
        rows = client.execute(
            f"""SELECT COALESCE(degree, '') AS degree, {bucket_sql} AS partition_year,
                      COUNT(*) AS document_count, MAX(updated_at) AS source_updated_at
               FROM documents
               GROUP BY COALESCE(degree, ''), {bucket_sql}
               ORDER BY degree, partition_year"""
        ).rows
        fingerprints = fetch_cohort_content_fingerprints(client)
        cohorts = []
        for row in rows:
            count = int(row["document_count"] or 0)
            if not count:
                continue
            degree = row["degree"] or ""
            bucket = int(row["partition_year"] or 0)
            scope = _cohort_scope_from_bucket(degree, bucket)
            cohorts.append({
                "scope": scope, "key": partition_key(scope, "automatic"), "count": count,
                "sourceUpdatedAt": row["source_updated_at"],
                "fingerprint": fingerprints.get((degree, bucket), ""),
            })
        existing_by_key = {
            row["partition_key"]: row for row in client.execute("SELECT * FROM concept_partitions").rows
        }

    ranked = []
    blocked = []
    publication_changed = False
    seen_keys = set()
    blocked_writes = []
    normal_upsert_rows = []

    for cohort in cohorts:
        key = cohort["key"]
        scope = cohort["scope"]
        count = cohort["count"]
        seen_keys.add(key)
        existing = existing_by_key.get(key)
        scope_json = json.dumps(scope, sort_keys=True)

        if count > MAX_PARTITION_DOCUMENTS:
            message = (
                f"Concept partition {key} contains {count} documents; refine it into non-overlapping program "
                f"scopes or raise CONCEPT_PARTITION_MAX_DOCUMENTS={MAX_PARTITION_DOCUMENTS} after capacity testing."
            )
            if explicit_scope:
                raise ValueError(message)
            if existing and int(existing["enabled"] or 0) == 1 and int(existing["artifact_version"] or 0) > 0:
                publication_changed = True
            # source_updated_at is deliberately NOT part of this comparison: it is
            # informational only (see the dirty check below, #22) and including it
            # here would write on every pass a routine metadata refresh bumps
            # documents.updated_at, even with the cohort's status/count/fingerprint
            # genuinely unchanged -- defeating the "unchanged rerun is a no-op"
            # guarantee for exactly the case it exists to cover.
            unchanged = (
                existing is not None
                and existing["scope_json"] == scope_json
                and int(existing["enabled"] or 0) == 0
                and existing["status"] == "blocked"
                and int(existing["source_document_count"] or 0) == count
                and str(existing["error"] or "") == message
            )
            if not unchanged:
                blocked_writes.append((key, scope_json, int(priority), count, cohort["sourceUpdatedAt"], message, now))
            blocked.append(message)
            continue

        last_completed = existing["last_completed_at"] if existing else None
        existing_fingerprint = existing["content_fingerprint"] if existing else None
        dirty = (
            force or not last_completed
            or (existing is not None and existing["status"] != "complete")
            or (existing is not None and int(existing["source_document_count"] or 0) != count)
            or str(cohort["fingerprint"] or "") != str(existing_fingerprint or "")
        )
        effective_priority = max(int(existing["priority"] or 0), int(priority)) if existing else int(priority)
        effective_enabled = 0 if explicit_scope else 1
        effective_status = "pending" if dirty else "complete"
        # source_updated_at is deliberately NOT part of this comparison -- see the
        # matching note on the blocked-cohort branch above. It is still persisted
        # (below) whenever some *other* field changes, so it is never wildly
        # stale; it just isn't, on its own, a reason to write.
        unchanged = (
            existing is not None
            and existing["scope_json"] == scope_json
            and int(existing["priority"] or 0) == effective_priority
            and int(existing["enabled"] or 0) == effective_enabled
            and existing["status"] == effective_status
            and int(existing["source_document_count"] or 0) == count
            and str(existing["content_fingerprint"] or "") == str(cohort["fingerprint"] or "")
        )
        if not unchanged:
            normal_upsert_rows.append((
                key, scope_json, int(priority), effective_enabled, effective_status,
                count, cohort["sourceUpdatedAt"], cohort["fingerprint"], now,
            ))
        if dirty:
            ranked.append((int(priority) + (1000 if not last_completed else 0), str(last_completed or ""), key, scope, count))

    for row in blocked_writes:
        client.execute(
            """INSERT INTO concept_partitions (
                 partition_key, scope_json, priority, enabled, status, source_document_count,
                 source_updated_at, error, updated_at
               ) VALUES (?, ?, ?, 0, 'blocked', ?, ?, ?, ?)
               ON CONFLICT(partition_key) DO UPDATE SET
                 scope_json = excluded.scope_json, enabled = 0, status = 'blocked',
                 source_document_count = excluded.source_document_count,
                 source_updated_at = excluded.source_updated_at, error = excluded.error,
                 updated_at = excluded.updated_at""",
            list(row),
        )
    _upsert_partition_rows_bulk(client, normal_upsert_rows)

    if not explicit_scope:
        # Retirement: a set difference over data already in memory, rather than
        # relying on every surviving cohort's updated_at being bumped this pass to
        # mark it "seen" -- that bump is exactly the unconditional write #20 removes.
        currently_enabled_keys = {
            key for key, row in existing_by_key.items() if int(row["enabled"] or 0) == 1
        }
        retire_keys = currently_enabled_keys - seen_keys
        publication_changed = publication_changed or bool(retire_keys)
        if retire_keys:
            retire_list = sorted(retire_keys)
            for start in range(0, len(retire_list), PARTITION_KEY_CHUNK_SIZE):
                chunk = retire_list[start:start + PARTITION_KEY_CHUNK_SIZE]
                placeholders = ",".join("?" for _ in chunk)
                client.execute(
                    f"""UPDATE concept_partitions SET enabled = 0, status = 'retired', updated_at = ?
                        WHERE partition_key IN ({placeholders})""",
                    [now, *chunk],
                )
        if publication_changed:
            # A removed shard can move phrases below the corpus-wide DF gate.
            # Re-rank every surviving shard before publishing the new generation.
            client.execute(
                "UPDATE concept_partitions SET status = 'pending', updated_at = ? WHERE enabled = 1 AND status = 'complete'",
                [utc_now()],
            )
            ranked_keys = {item[2] for item in ranked}
            for key, row in existing_by_key.items():
                if key in retire_keys or key in ranked_keys:
                    continue
                if int(row["enabled"] or 0) == 1 and row["status"] == "complete":
                    ranked.append((
                        int(row["priority"] or 0), str(row["last_completed_at"] or ""),
                        key, json.loads(row["scope_json"]), int(row["source_document_count"] or 0),
                    ))

    if not ranked:
        if not explicit_scope and (publication_changed or global_publication_pending(client)):
            return {"publishOnly": True, "publishGlobally": True, "warnings": blocked[:3]}
        if blocked:
            raise ValueError(" ".join(blocked[:3]))
        return None
    ranked.sort(key=lambda item: (-item[0], item[1], item[2]))
    _, _, key, scope, count = ranked[0]
    return {
        "key": key, "scope": scope, "documentCount": count,
        "publishGlobally": not explicit_scope,
    }


def load_partition_documents(client, scope):
    where, args = scope_where(scope)
    rows = client.execute(
        f"SELECT d.doc_id, d.metadata_json, d.updated_at FROM documents d{where} ORDER BY d.doc_id LIMIT ?",
        [*args, MAX_PARTITION_DOCUMENTS + 1],
    ).rows
    if len(rows) > MAX_PARTITION_DOCUMENTS:
        raise ValueError(f"Partition exceeds the {MAX_PARTITION_DOCUMENTS}-document memory boundary.")
    docs = []
    failures = 0
    for row in rows:
        try:
            meta = json.loads(row["metadata_json"])
            text = document_text(meta)
            if text:
                docs.append({"id": row["doc_id"], "meta": meta, "text": text, "updatedAt": row["updated_at"]})
        except Exception:
            failures += 1
    return docs, failures


def content_checksum(doc):
    return hashlib.sha256(
        (PIPELINE_VERSION + "\0" + MODEL_NAME + "\0" + doc["text"]).encode("utf-8")
    ).hexdigest()


def load_document_states(client, key):
    rows = client.execute(
        "SELECT doc_id, content_checksum, candidates_json, embedding_json, model_name FROM concept_document_state WHERE partition_key = ?",
        [key],
    ).rows
    return {row["doc_id"]: row for row in rows}


def vector_json(vector):
    return json.dumps([round(float(value), 7) for value in vector], separators=(",", ":"))


def checkpoint_documents(client, key, docs, states, reporter, processed, total):
    now = utc_now()
    if docs:
        placeholders = ",".join("(?, ?, ?, ?, ?, ?, ?)" for _ in docs)
        values = []
        for doc in docs:
            state = states[doc["id"]]
            values.extend([
                key, doc["id"], state["checksum"], json.dumps(sorted(state["candidates"])),
                vector_json(state["embedding"]), MODEL_NAME, now,
            ])
        client.execute(
            f"""INSERT INTO concept_document_state (
                 partition_key, doc_id, content_checksum, candidates_json,
                 embedding_json, model_name, processed_at
               ) VALUES {placeholders}
               ON CONFLICT(partition_key, doc_id) DO UPDATE SET
                 content_checksum = excluded.content_checksum,
                 candidates_json = excluded.candidates_json,
                 embedding_json = excluded.embedding_json,
                 model_name = excluded.model_name,
                 processed_at = excluded.processed_at""",
            values,
        )
    last_doc_id = docs[-1]["id"] if docs else None
    checkpoint = {"phase": "document_state", "lastDocId": last_doc_id, "processed": processed, "total": total}
    client.execute(
        "UPDATE concept_partitions SET checkpoint_json = ?, status = 'running', updated_at = ? WHERE partition_key = ?",
        [json.dumps(checkpoint), now, key],
    )
    reporter.report(
        "embedding", "Checkpointing Document State",
        detail=f"Checkpointed {processed} of {total} documents.",
        counts={"processed": processed, "total": total, "lastDocId": last_doc_id},
    )


def save_partition_candidates(client, key, phrase_docs, participates_globally=True):
    """Persist local DF and return corpus-wide DF for phrases in this shard."""
    old_rows = client.execute(
        "SELECT phrase, document_frequency FROM concept_partition_candidates WHERE partition_key = ?",
        [key],
    ).rows
    old = {row["phrase"]: int(row["document_frequency"] or 0) for row in old_rows}
    new = {phrase: len(doc_ids) for phrase, doc_ids in phrase_docs.items()}
    union_phrases = sorted(set(old) | set(new))
    other = {}
    if participates_globally:
        for start in range(0, len(union_phrases), 250):
            chunk = union_phrases[start:start + 250]
            placeholders = ",".join("?" for _ in chunk)
            rows = client.execute(
                f"""SELECT cpc.phrase, SUM(cpc.document_frequency) AS document_frequency
                    FROM concept_partition_candidates cpc
                    JOIN concept_partitions cp ON cp.partition_key = cpc.partition_key AND cp.enabled = 1
                    WHERE cpc.partition_key <> ? AND cpc.phrase IN ({placeholders})
                    GROUP BY cpc.phrase""",
                [key, *chunk],
            ).rows
            for row in rows:
                other[row["phrase"]] = int(row["document_frequency"] or 0)

    items = sorted(new.items())
    for start in range(0, len(items), 100):
        chunk = items[start:start + 100]
        placeholders = ",".join("(?, ?, ?)" for _ in chunk)
        values = []
        for phrase, frequency in chunk:
            values.extend([key, phrase, frequency])
        client.execute(
            f"""INSERT INTO concept_partition_candidates (
                   partition_key, phrase, document_frequency
                 ) VALUES {placeholders}
                 ON CONFLICT(partition_key, phrase) DO UPDATE SET
                   document_frequency = excluded.document_frequency""",
            values,
        )
    removed = sorted(set(old) - set(new))
    for start in range(0, len(removed), 250):
        chunk = removed[start:start + 250]
        placeholders = ",".join("?" for _ in chunk)
        client.execute(
            f"DELETE FROM concept_partition_candidates WHERE partition_key = ? AND phrase IN ({placeholders})",
            [key, *chunk],
        )

    affected = [
        phrase for phrase in union_phrases
        if participates_globally
        and (other.get(phrase, 0) + old.get(phrase, 0) >= MIN_DOCUMENT_FREQUENCY)
        != (other.get(phrase, 0) + new.get(phrase, 0) >= MIN_DOCUMENT_FREQUENCY)
    ]
    for start in range(0, len(affected), 250):
        chunk = affected[start:start + 250]
        placeholders = ",".join("?" for _ in chunk)
        client.execute(
            f"""UPDATE concept_partitions SET status = 'pending', updated_at = ?
                WHERE enabled = 1 AND partition_key <> ? AND status = 'complete'
                  AND partition_key IN (
                    SELECT partition_key FROM concept_partition_candidates
                    WHERE phrase IN ({placeholders})
                  )""",
            [utc_now(), key, *chunk],
        )
    return {phrase: other.get(phrase, 0) + frequency for phrase, frequency in new.items()}


def global_partition_readiness(client):
    rows = client.execute(
        """SELECT COUNT(*) AS total,
                  SUM(CASE WHEN status = 'complete' AND artifact_version > 0 THEN 1 ELSE 0 END) AS ready
           FROM concept_partitions WHERE enabled = 1"""
    ).rows
    total = int(rows[0]["total"] or 0) if rows else 0
    ready = int(rows[0]["ready"] or 0) if rows else 0
    return {"total": total, "ready": ready, "pending": total - ready, "complete": total > 0 and total == ready}


def global_generation_signature(client):
    rows = client.execute(
        """SELECT partition_key, artifact_version FROM concept_partitions
           WHERE enabled = 1 ORDER BY partition_key"""
    ).rows
    encoded = json.dumps(
        [[row["partition_key"], int(row["artifact_version"] or 0)] for row in rows],
        separators=(",", ":"),
    )
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def global_publication_pending(client):
    readiness = global_partition_readiness(client)
    if readiness["total"] > 0 and not readiness["complete"]:
        return False
    rows = client.execute(
        "SELECT published_signature FROM concept_publication_state WHERE id = 1"
    ).rows
    published = rows[0]["published_signature"] if rows else None
    return published != global_generation_signature(client)


def mark_global_published(client):
    client.execute(
        """INSERT INTO concept_publication_state (id, published_signature, published_at)
           VALUES (1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             published_signature = excluded.published_signature,
             published_at = excluded.published_at""",
        [global_generation_signature(client), utc_now()],
    )


def load_phrase_embeddings(client, phrases):
    found = {}
    phrase_list = sorted(phrases)
    for start in range(0, len(phrase_list), 300):
        chunk = phrase_list[start:start + 300]
        placeholders = ",".join("?" for _ in chunk)
        rows = client.execute(
            f"SELECT phrase, embedding_json FROM concept_phrase_embeddings WHERE model_name = ? AND phrase IN ({placeholders})",
            [MODEL_NAME, *chunk],
        ).rows
        for row in rows:
            found[row["phrase"]] = json.loads(row["embedding_json"])
    return found


def save_phrase_embeddings(client, embeddings):
    now = utc_now()
    items = list(embeddings.items())
    for start in range(0, len(items), 100):
        chunk = items[start:start + 100]
        placeholders = ",".join("(?, ?, ?, ?)" for _ in chunk)
        values = []
        for phrase, vector in chunk:
            values.extend([MODEL_NAME, phrase, vector_json(vector), now])
        client.execute(
            f"""INSERT INTO concept_phrase_embeddings (model_name, phrase, embedding_json, updated_at)
               VALUES {placeholders}
               ON CONFLICT(model_name, phrase) DO UPDATE SET
                 embedding_json = excluded.embedding_json, updated_at = excluded.updated_at""",
            values,
        )


class DeterministicTestEmbeddingModel:
    """Small stable embedding model used only by the integration test suite."""

    @staticmethod
    def encode(values, **_kwargs):
        vectors = []
        for value in values:
            digest = hashlib.sha256(str(value).encode("utf-8")).digest()
            vectors.append([(byte - 127.5) / 127.5 for byte in digest[:24]])
        return vectors


def load_embedding_model():
    backend = os.environ.get("CONCEPT_EMBEDDING_BACKEND", "sentence_transformer").strip()
    if backend == "deterministic_test":
        if os.environ.get("NODE_ENV") != "test":
            raise ValueError("The deterministic concept embedding backend is restricted to NODE_ENV=test.")
        return DeterministicTestEmbeddingModel()
    if backend != "sentence_transformer":
        raise ValueError(f"Unsupported CONCEPT_EMBEDDING_BACKEND: {backend}")
    from sentence_transformers import SentenceTransformer
    return SentenceTransformer(MODEL_NAME)


def save_partition_artifact(client, key, scope, artifact):
    current = client.execute(
        "SELECT artifact_version FROM concept_partitions WHERE partition_key = ?", [key]
    ).rows[0]
    version = int(current["artifact_version"] or 0) + 1
    now = utc_now()
    artifact["partition"] = {"key": key, "scope": scope, "version": version}
    client.execute(
        "INSERT INTO concept_partition_artifacts (partition_key, version, artifact_json, document_count, created_at) VALUES (?, ?, ?, ?, ?)",
        [key, version, json.dumps(artifact), artifact["stats"]["documents"], now],
    )
    client.execute(
        """UPDATE concept_partitions SET status = 'complete', checkpoint_json = NULL,
             artifact_version = ?, last_completed_at = ?, error = NULL, updated_at = ?
           WHERE partition_key = ?""",
        [version, now, now, key],
    )
    return version


def merged_component_doc_freq(members, shards, total_docs):
    """Distinct documents mentioning any phrase in a merged component.

    Summing per-shard docFreq is wrong. Shards are disjoint in *documents*, but a
    merged component routinely contains two phrases that both came from the same
    shard -- that is precisely what the merge does, gluing together canonicals a
    shard deliberately kept apart. A document mentioning both is then counted
    twice, docFreq climbs past the corpus size, and idf goes negative.

    So union within each shard and only then add across shards. A shard artifact
    carries docIndexes (its concept's own document indexes, local to that shard),
    which makes the within-shard union exact. Artifacts written before that field
    existed fall back to an upper bound clamped to the shard's own document count,
    which is what keeps docFreq <= total_docs and idf >= 0.
    """
    total = 0
    for shard in shards:
        present = [phrase for phrase in members if phrase in shard["docFreq"]]
        if not present:
            continue
        indexed = [shard["docIndexes"][phrase] for phrase in present if phrase in shard["docIndexes"]]
        if len(indexed) == len(present):
            total += len(set().union(*indexed))
            continue
        total += min(
            sum(shard["docFreq"][phrase] for phrase in present),
            shard["documents"],
        )
    return min(total, total_docs)


def merge_partition_artifacts(client):
    rows = client.execute(
        """SELECT cpa.artifact_json
           FROM concept_partition_artifacts cpa
           JOIN concept_partitions cp ON cp.partition_key = cpa.partition_key AND cp.enabled = 1
           WHERE cpa.version = cp.artifact_version
           ORDER BY cp.priority DESC, cp.partition_key"""
    ).rows
    total_docs = 0
    truncated_buckets = 0
    truncated_heads = 0
    shard_extension_hubs_skipped = 0
    shard_extension_edges_skipped = 0
    shard_doc_freq = {}
    shard_score = {}
    shards = []
    partitions = []
    relations = DisjointSet()
    # R3 (extension) edges are deferred rather than unioned immediately: fan-in was
    # already enforced once, per shard, by cluster_phrases, but shard A keeping 2
    # extensions of hub X and shard B independently keeping a *different* 2 of the
    # same hub X each stay within their own shard's cap while jointly exceeding the
    # global one once naively unioned (#31). So R1/R2 edges (no cap, never cross a
    # token-count boundary -- see classify_variant_rule) are applied immediately, and
    # every R3 edge is collected here to be re-checked, as one global population,
    # after every shard has been scanned.
    extension_edges = set()
    # phrase -> [(shard_index, docFreq, patternRankScore), ...], populated only for
    # R3 variants (see the loop below) and consulted only if the fan-in re-check
    # ends up withholding that specific phrase from its hub.
    orphaned_extension_doc_freq = {}
    for row in rows:
        artifact = json.loads(row["artifact_json"])
        stats = artifact.get("stats", {})
        documents = int(stats.get("documents", 0))
        total_docs += documents
        # Carry each shard's R2 truncation forward: the merged dictionary is where an
        # operator looks, and under-clustering in any shard shows up there.
        truncated_buckets += int(stats.get("clusterTruncatedBuckets", 0) or 0)
        truncated_heads += int(stats.get("clusterTruncatedHeads", 0) or 0)
        shard_extension_hubs_skipped += int(stats.get("clusterExtensionHubsSkipped", 0) or 0)
        shard_extension_edges_skipped += int(stats.get("clusterExtensionEdgesSkipped", 0) or 0)
        partitions.append(artifact.get("partition", {}))
        shard_index = len(shards)
        shard = {"documents": documents, "docFreq": {}, "docIndexes": {}}
        for concept in artifact.get("concepts", []):
            canonical = concept.get("canonical")
            if not canonical:
                continue
            doc_freq = int(concept.get("docFreq", 0))
            shard["docFreq"][canonical] = doc_freq
            indexes = concept.get("docIndexes")
            if isinstance(indexes, list):
                shard["docIndexes"][canonical] = {int(index) for index in indexes}
            # A canonical appears at most once per shard, so summing this key across
            # shards - which really are document-disjoint - is sound. Only the
            # component-level roll-up below has to union instead of add.
            shard_doc_freq[canonical] = shard_doc_freq.get(canonical, 0) + doc_freq
            score = float(concept.get("patternRankScore", 0))
            shard_score[canonical] = max(shard_score.get(canonical, 0.0), score)
            relations.add(canonical)
            variant_rules = concept.get("variantRules") or {}
            variant_doc_freq = concept.get("variantDocFreq") or {}
            for variant in concept.get("variants", []) or []:
                relations.add(variant)
                rule = variant_rules.get(variant) or classify_variant_rule(canonical, variant)
                if rule == "R3":
                    # Deliberately NOT folded into shard_doc_freq/shard["docFreq"]
                    # here (unlike the canonical, above): a variant's own frequency
                    # is already fully represented via its shard's canonical, whose
                    # docFreq is the *cluster's* combined frequency. Adding it again
                    # here would double count it in both the canonical-tie-break
                    # (`attested`, below) and merged_component_doc_freq's per-shard
                    # sum -- confirmed by reproduction: it silently swapped which of
                    # "learning community"/"learning communities" won the R1 tie
                    # once both carried an equal, inflated shard_doc_freq. Recorded
                    # here only as a fallback source, applied lazily (see
                    # orphaned_extension_doc_freq below) if and only if the fan-in
                    # re-check actually withholds this specific phrase from its hub
                    # -- the one case where it stops being reachable any other way.
                    vdf = int(variant_doc_freq.get(variant, 0) or 0)
                    if vdf:
                        orphaned_extension_doc_freq.setdefault(variant, []).append((shard_index, vdf, score))
                    # R3 only ever connects a 2-gram (the hub) to a 3-gram (the
                    # extension it absorbs); token count alone tells them apart
                    # regardless of which one this shard chose as its canonical.
                    if len(canonical.split()) < len(variant.split()):
                        extension_edges.add((canonical, variant))
                    else:
                        extension_edges.add((variant, canonical))
                else:
                    relations.union(variant, canonical)
        shards.append(shard)

    # Global fan-in re-check, mirroring cluster_phrases's own algorithm (roots
    # snapshotted before any extension is applied; fan-in counted in distinct
    # components, not surface forms) but over the merged R1/R2-only forest built
    # above, so a hub's *global* absorption -- not just each shard's local slice of
    # it -- is what gets capped.
    roots_before = {}
    for hub, extension in extension_edges:
        roots_before.setdefault(hub, relations.find(hub))
        roots_before.setdefault(extension, relations.find(extension))
    extensions_by_hub_root = {}
    hub_repr = {}
    for hub, extension in extension_edges:
        root = roots_before[hub]
        extensions_by_hub_root.setdefault(root, set()).add(extension)
        hub_repr[root] = min(hub_repr.get(root, hub), hub)

    merge_extension_hubs_skipped = 0
    merge_extension_edges_skipped = 0
    merge_skipped_hub_sample = []
    for root in sorted(extensions_by_hub_root, key=lambda item: hub_repr[item]):
        absorbed = extensions_by_hub_root[root]
        distinct = {roots_before[phrase] for phrase in absorbed} - {root}
        if len(distinct) > MAX_VARIANT_EXTENSION_FAN_IN:
            # Not logged here: merge_partition_artifacts has no reporter and existing
            # test harnesses (merge_harness.py and friends) parse its stdout as a
            # single JSON blob, so a stray print() here would break them. main()
            # logs a summary from mergeExtensionHubsSkipped/EdgesSkipped once merge
            # returns instead (see the two call sites below).
            merge_extension_hubs_skipped += 1
            merge_extension_edges_skipped += len(absorbed)
            if len(merge_skipped_hub_sample) < 5:
                merge_skipped_hub_sample.append(hub_repr[root])
            # A withheld phrase stops being reachable via its hub's cluster, so give
            # it its own standalone attestation now if it has no other source (i.e.
            # it was never any shard's own canonical) -- otherwise it would silently
            # vanish from the merged dictionary rather than surviving as its own
            # concept, the way a per-shard-withheld extension already does.
            for phrase in absorbed:
                if phrase in shard_doc_freq:
                    continue
                for shard_index, vdf, score in orphaned_extension_doc_freq.get(phrase, []):
                    shards[shard_index]["docFreq"][phrase] = shards[shard_index]["docFreq"].get(phrase, 0) + vdf
                    shard_doc_freq[phrase] = shard_doc_freq.get(phrase, 0) + vdf
                    shard_score[phrase] = max(shard_score.get(phrase, 0.0), score)
            continue
        for phrase in absorbed:
            relations.union(root, phrase)

    # Cross-shard collision rule. Shard A may call a phrase a variant of X while shard
    # B calls the same phrase a variant of Y, or promotes it to a canonical of its own.
    # Last-write-wins would make the merged dictionary depend on partition iteration
    # order, so instead every (variant, canonical) pair is treated as an undirected
    # "these are the same concept" edge and the connected component is resolved as a
    # whole. Two canonicals that share a variant genuinely are near-duplicates, so
    # collapsing them is the correct reading of the evidence, not a lossy tie-break.
    # Within a component the winner is the phrase with the highest summed document
    # frequency, then the highest PatternRank score, then the lexicographically
    # smallest phrase - a total order over data that is identical no matter which
    # shard was merged first.
    concepts = []
    for members in relations.components():
        attested = [phrase for phrase in members if phrase in shard_doc_freq]
        if not attested:
            continue
        canonical = min(
            attested,
            key=lambda phrase: (-shard_doc_freq.get(phrase, 0), -shard_score.get(phrase, 0.0), phrase),
        )
        doc_freq = merged_component_doc_freq(members, shards, total_docs)
        concepts.append({
            "canonical": canonical,
            "variants": sorted(phrase for phrase in members if phrase != canonical),
            "docFreq": doc_freq,
            # doc_freq <= total_docs is guaranteed above, so this is already >= 0;
            # max() is belt and braces against a future change reintroducing the
            # negative idf that silently drops concepts at the assignment gate.
            "idf": max(0.0, math.log((total_docs + 1) / (doc_freq + 1))) if total_docs else 0,
            "patternRankScore": round(max((shard_score.get(phrase, 0.0) for phrase in members), default=0.0), 4),
            "source": "patternrank_partition_merge",
        })
    concepts.sort(key=lambda concept: (-concept["docFreq"], -concept["patternRankScore"], concept["canonical"]))
    concepts = concepts[:MAX_GLOBAL_CONCEPTS]
    variant_to_canonical = build_variant_map(
        concepts, doc_freq_for=lambda phrase: merged_component_doc_freq([phrase], shards, total_docs)
    )
    generated_at = utc_now()
    merged = {
        # v4: see the matching comment at the partition-artifact site. The merged
        # artifact additionally carries mergeExtensionHubsSkipped/EdgesSkipped,
        # counting *only* cross-shard fan-in caught by this function's own re-check
        # (#31); clusterExtensionHubsSkipped/EdgesSkipped below is the truthful total
        # -- every shard's own permanently-withheld edges (which the merge cannot
        # and does not reinstate) plus this merge-level re-check's own withholding.
        "version": 4,
        "generatedAt": generated_at,
        "source": {"documents": total_docs, "method": "patternrank_incremental", "model": MODEL_NAME, "partitions": partitions},
        "stats": {
            "candidatePhrases": len(concepts), "qualityFilteredPhrases": len(concepts),
            # Now that docFreq is a real distinct-document count, a concept seen in
            # exactly one document is again exactly the ones this counts. The old
            # summed docFreq inflated components past 1 and undercounted this.
            "concepts": len(concepts), "singleDocConcepts": sum(1 for concept in concepts if concept["docFreq"] == 1),
            "aliases": len(variant_to_canonical), "patternRankRejected": 0, "documents": total_docs, "failed": 0,
            "clusterTruncatedBuckets": truncated_buckets, "clusterTruncatedHeads": truncated_heads,
            "clusterExtensionHubsSkipped": shard_extension_hubs_skipped + merge_extension_hubs_skipped,
            "clusterExtensionEdgesSkipped": shard_extension_edges_skipped + merge_extension_edges_skipped,
            "mergeExtensionHubsSkipped": merge_extension_hubs_skipped,
            "mergeExtensionEdgesSkipped": merge_extension_edges_skipped,
            "mergeExtensionHubsSkippedSample": merge_skipped_hub_sample,
            "partitions": len(partitions),
        },
        "concepts": concepts,
        "variantToCanonical": variant_to_canonical,
    }
    assert_document_frequency_invariants(merged, "merged concept artifact")
    return assert_alias_invariants(merged, "merged concept artifact")


def log_merge_fanin(reporter, merged_artifact):
    """Log cross-shard extension fan-in withheld by merge_partition_artifacts's own
    re-check (#31), if any. Kept out of merge_partition_artifacts itself so its
    output stays pure JSON for the existing test harnesses that parse its stdout."""
    stats = merged_artifact.get("stats", {})
    hubs = int(stats.get("mergeExtensionHubsSkipped", 0) or 0)
    edges = int(stats.get("mergeExtensionEdgesSkipped", 0) or 0)
    if hubs:
        sample = stats.get("mergeExtensionHubsSkippedSample") or []
        sample_note = f" (e.g. {', '.join(repr(s) for s in sample)})" if sample else ""
        reporter.append_log(
            f"{hubs} hub(s){sample_note} would have exceeded the extension fan-in limit only once "
            f"every shard's independently-kept extensions were combined at merge time; {edges} "
            "extension(s) were withheld from their hub and kept as distinct concepts instead.\n"
        )


def main():
    db_path = os.path.abspath(os.environ.get("SQLITE_PATH", DB_PATH))
    if not os.environ.get("TURSO_DATABASE_URL") and not os.path.exists(db_path):
        print(f"Error: database not found at {db_path}", file=sys.stderr)
        sys.exit(1)

    client = get_db_client(db_path)
    job_id = os.environ.get("ADMIN_JOB_ID")
    claim_job(client, job_id)
    reporter = JobReporter(client, job_id)

    selected = None
    try:
        ensure_incremental_schema(client)
        params = load_job_params(client, job_id)
        reporter.append_log("Starting incremental, partitioned PatternRank processing.\n")
        reporter.report("partition_selection", "Selecting Partition", detail="Selecting the highest-priority changed corpus partition...")
        selected = discover_partition(
            client,
            requested_scope=params.get("scope"),
            priority=int(params.get("priority") or 0),
            force=bool(params.get("force")),
        )
        if not selected:
            result = {"documents": 0, "documentsChanged": 0, "partitions": 0, "noChanges": True, "method": "patternrank_incremental"}
            reporter.report("complete", "Complete", status="completed", detail="No changed concept partition is pending.", counts=result)
            reporter.finish("completed", result=result)
            client.close()
            return

        if selected.get("publishOnly"):
            readiness = global_partition_readiness(client)
            if readiness["total"] > 0 and not readiness["complete"]:
                raise ValueError(
                    f"Cannot republish after partition retirement while {readiness['pending']} partitions are pending."
                )
            merged_artifact = merge_partition_artifacts(client)
            log_merge_fanin(reporter, merged_artifact)
            upload_concept_artifact(merged_artifact)
            mark_global_published(client)
            result = {
                "documents": merged_artifact["stats"]["documents"],
                "partitions": readiness["total"], "partitionsPending": 0,
                "mergedConcepts": len(merged_artifact["concepts"]),
                "mergedAliases": merged_artifact["stats"]["aliases"],
                "globalPublished": True, "publicationOnly": True,
                "warnings": selected.get("warnings") or [],
                "method": "patternrank_incremental",
            }
            reporter.report(
                "write_results", "Publishing Retired Partition Update", status="completed",
                detail="Republished the global dictionary without retired partition artifacts.", counts=result,
            )
            reporter.finish("completed", result=result)
            client.close()
            return

        key = selected["key"]
        scope = selected["scope"]
        client.execute(
            "UPDATE concept_partitions SET status = 'running', last_started_at = ?, error = NULL, updated_at = ? WHERE partition_key = ?",
            [utc_now(), utc_now(), key],
        )
        reporter.report(
            "partition_selection", "Selecting Partition", status="completed",
            detail=f"Selected {key} ({selected['documentCount']} documents).",
            counts={"partition": key, "documents": selected["documentCount"]},
            next_task="Loading Partition Documents",
        )

        docs, failures = load_partition_documents(client, scope)
        if not docs:
            raise ValueError(f"Partition {key} has no documents with usable text.")
        reporter.report(
            "load_documents", "Loading Partition Documents", status="completed",
            detail=f"Loaded {len(docs)} documents from {key}.",
            counts={"processed": len(docs), "total": selected["documentCount"], "failed": failures},
            next_task="Generating Changed Candidates",
        )

        stored = load_document_states(client, key)
        active_ids = {doc["id"] for doc in docs}
        for stale_id in set(stored) - active_ids:
            client.execute("DELETE FROM concept_document_state WHERE partition_key = ? AND doc_id = ?", [key, stale_id])

        state_by_doc = {}
        changed_docs = []
        reused = 0
        generated = 0
        for idx, doc in enumerate(docs):
            checksum = content_checksum(doc)
            row = stored.get(doc["id"])
            if row and row["content_checksum"] == checksum and row["model_name"] == MODEL_NAME:
                try:
                    candidates = set(json.loads(row["candidates_json"]))
                    embedding = json.loads(row["embedding_json"])
                    reused += 1
                except Exception:
                    candidates = extract_candidates(doc["meta"])
                    embedding = None
                    changed_docs.append(doc)
            else:
                candidates = extract_candidates(doc["meta"])
                embedding = None
                changed_docs.append(doc)
            generated += len(candidates)
            state_by_doc[doc["id"]] = {"checksum": checksum, "candidates": candidates, "embedding": embedding}
            if idx % CHECKPOINT_BATCH_SIZE == 0:
                reporter.report(
                    "candidate_generation", "Generating Changed Candidates",
                    detail=f"Inspected {idx + 1} of {len(docs)} documents.",
                    counts={"processed": idx + 1, "total": len(docs), "changed": len(changed_docs), "reused": reused, "candidates": generated},
                )

        phrase_docs = {}
        for idx, doc in enumerate(docs):
            for phrase in state_by_doc[doc["id"]]["candidates"]:
                phrase_docs.setdefault(phrase, set()).add(idx)
        global_document_frequency = save_partition_candidates(
            client, key, phrase_docs, participates_globally=selected["publishGlobally"]
        )
        qualifying_phrases = {
            phrase for phrase in phrase_docs
            if global_document_frequency.get(phrase, 0) >= MIN_DOCUMENT_FREQUENCY
        }
        rejected_gate = sum(len(ids) for phrase, ids in phrase_docs.items() if phrase not in qualifying_phrases)
        reporter.report(
            "candidate_generation", "Generating Changed Candidates", status="completed",
            detail=f"Reused {reused} documents and regenerated {len(changed_docs)}; {len(qualifying_phrases)} phrases passed document-frequency gating.",
            counts={
                "processed": len(docs), "total": len(docs), "changed": len(changed_docs), "reused": reused,
                "candidates": generated, "accepted": len(qualifying_phrases), "rejected": rejected_gate, "failed": failures,
            },
            next_task="Computing Missing Embeddings",
        )

        phrase_embedding_map = load_phrase_embeddings(client, qualifying_phrases)
        missing_phrases = sorted(qualifying_phrases - set(phrase_embedding_map))
        model = None
        if changed_docs or missing_phrases:
            reporter.append_log(f"Loading sentence-transformer model for missing embeddings: {MODEL_NAME}\n")
            model = load_embedding_model()
        if changed_docs:
            for start in range(0, len(changed_docs), CHECKPOINT_BATCH_SIZE):
                chunk = changed_docs[start:start + CHECKPOINT_BATCH_SIZE]
                encoded = model.encode([doc["text"] for doc in chunk], show_progress_bar=False, batch_size=16)
                for doc, embedding in zip(chunk, encoded):
                    state_by_doc[doc["id"]]["embedding"] = embedding
                checkpoint_documents(client, key, chunk, state_by_doc, reporter, min(start + len(chunk), len(changed_docs)), len(changed_docs))
        if missing_phrases:
            encoded_phrases = model.encode(missing_phrases, show_progress_bar=False, batch_size=64)
            new_phrase_embeddings = {phrase: embedding for phrase, embedding in zip(missing_phrases, encoded_phrases)}
            save_phrase_embeddings(client, new_phrase_embeddings)
            phrase_embedding_map.update(new_phrase_embeddings)
        reporter.report(
            "embedding", "Computing Missing Embeddings", status="completed",
            detail=f"Computed {len(changed_docs)} document and {len(missing_phrases)} phrase embeddings; reused all others.",
            counts={
                "documentsComputed": len(changed_docs), "documentsReused": reused,
                "phrasesComputed": len(missing_phrases), "phrasesReused": len(phrase_embedding_map) - len(missing_phrases),
            },
            next_task="Ranking Candidates",
        )

        accepted_by_doc = [set() for _ in docs]
        phrase_scores = {}
        rejected_rank = 0
        for idx, doc in enumerate(docs):
            document_embedding = state_by_doc[doc["id"]]["embedding"]
            ranked = []
            for phrase in state_by_doc[doc["id"]]["candidates"]:
                if phrase not in phrase_embedding_map:
                    continue
                ranked.append((cosine(document_embedding, phrase_embedding_map[phrase]), phrase))
            ranked.sort(reverse=True)
            for score, phrase in ranked[:TOP_CANDIDATES_PER_DOC]:
                if score >= MIN_RANK_SCORE:
                    accepted_by_doc[idx].add(phrase)
                    phrase_scores[phrase] = max(phrase_scores.get(phrase, 0), score)
                else:
                    rejected_rank += 1
            if idx % CHECKPOINT_BATCH_SIZE == 0:
                reporter.report(
                    "ranking", "Ranking Candidates", detail=f"Ranked {idx + 1} of {len(docs)} documents.",
                    counts={"processed": idx + 1, "total": len(docs), "accepted": sum(len(values) for values in accepted_by_doc), "rejected": rejected_rank},
                )

        accepted_docs = {}
        for idx, phrases_for_doc in enumerate(accepted_by_doc):
            for phrase in phrases_for_doc:
                accepted_docs.setdefault(phrase, set()).add(idx)
        # Cluster variants inside this partition only. The phrase set is bounded by the
        # partition's own accepted candidates, so the work never scales with the corpus.
        phrase_document_frequency = {phrase: len(ids) for phrase, ids in accepted_docs.items()}
        clusters, cluster_truncation = cluster_phrases(set(accepted_docs), phrase_document_frequency)
        if cluster_truncation["truncatedBuckets"]:
            reporter.append_log(
                f"Variant clustering hit the {cluster_truncation['comparisonBudget']}-comparison budget in "
                f"{cluster_truncation['truncatedBuckets']} modifier bucket(s) of partition {key}, abandoning "
                f"{cluster_truncation['truncatedHeads']} head form(s). Legitimate variants were left unmerged, "
                "always the lexicographically later ones. Raise CONCEPT_MAX_BUCKET_COMPARISONS to cluster them.\n"
            )
        if cluster_truncation["extensionHubsSkipped"]:
            sample = cluster_truncation.get("extensionHubsSkippedSample") or []
            sample_note = f" (e.g. {', '.join(repr(s) for s in sample)})" if sample else ""
            reporter.append_log(
                f"{cluster_truncation['extensionHubsSkipped']} phrase(s) in partition {key} had more than "
                f"{cluster_truncation['extensionFanInLimit']} longer forms extending them{sample_note}, so "
                f"{cluster_truncation['extensionEdgesSkipped']} extension(s) were kept as distinct concepts "
                "rather than folded into the shorter phrase. These are hub topics, not sliding-window "
                "fragments. Raise CONCEPT_VARIANT_EXTENSION_MAX_FAN_IN to merge them anyway.\n"
            )
        concepts = []
        for cluster in clusters:
            canonical = pick_canonical(cluster, phrase_document_frequency)
            # Merge the document sets rather than the counts: a document mentioning both
            # a variant and its canonical must only be counted once.
            cluster_docs = set()
            for phrase in cluster:
                cluster_docs |= accepted_docs.get(phrase, set())
            concepts.append({
                "canonical": canonical,
                "variants": sorted(phrase for phrase in cluster if phrase != canonical),
                "docFreq": len(cluster_docs),
                # Document indexes local to this partition. The merge needs them to
                # union document sets across a component whose phrases came from the
                # same shard; counts alone cannot be unioned and double count. Total
                # size is bounded by TOP_CANDIDATES_PER_DOC * len(docs) indexes across
                # the whole artifact, because that is how many (phrase, document)
                # pairs the ranking stage can accept.
                "docIndexes": sorted(cluster_docs),
                "idf": math.log((len(docs) + 1) / (len(cluster_docs) + 1)),
                "patternRankScore": round(float(max(phrase_scores.get(phrase, 0) for phrase in cluster)), 4),
                "source": "patternrank_partition",
            })
        concepts.sort(key=lambda concept: (-concept["docFreq"], -concept["patternRankScore"], concept["canonical"]))
        concepts = concepts[:MAX_PARTITION_CONCEPTS]
        variant_to_canonical = build_variant_map(concepts, doc_freq_for=phrase_document_frequency.get)
        artifact = {
            # v4: concepts[].variants is unchanged (a plain phrase-string list), but
            # each concept now also carries variantRules/variantDocFreq (see
            # build_variant_map) so merge_partition_artifacts can re-enforce the
            # extension fan-in cap over the *global* component graph (#31/#35)
            # instead of trusting each shard's already-applied, shard-local cap.
            # Additive fields only -- no existing reader of concepts[].variants,
            # variantToCanonical, or stats needs to change for this bump.
            "version": 4, "generatedAt": utc_now(),
            "source": {"documents": len(docs), "method": "patternrank_incremental", "model": MODEL_NAME, "scope": scope},
            "stats": {
                "candidatePhrases": len(phrase_docs), "qualityFilteredPhrases": len(accepted_docs),
                "concepts": len(concepts),
                "singleDocConcepts": sum(1 for concept in concepts if concept["docFreq"] == 1),
                "aliases": len(variant_to_canonical),
                "patternRankRejected": rejected_rank, "documentFrequencyRejected": rejected_gate,
                # Non-zero means MAX_BUCKET_COMPARISONS stopped R2 early and this
                # partition is under-clustered: legitimate variants were left as
                # separate concepts, always the lexicographically later head forms.
                "clusterTruncatedBuckets": cluster_truncation["truncatedBuckets"],
                "clusterTruncatedHeads": cluster_truncation["truncatedHeads"],
                # Extension merges withheld because the shorter phrase is a hub with
                # many distinct longer forms, not a fragment of any one of them.
                "clusterExtensionHubsSkipped": cluster_truncation["extensionHubsSkipped"],
                "clusterExtensionEdgesSkipped": cluster_truncation["extensionEdgesSkipped"],
                "documents": len(docs), "documentsChanged": len(changed_docs), "documentsReused": reused, "failed": failures,
            },
            "concepts": concepts, "variantToCanonical": variant_to_canonical,
        }
        assert_alias_invariants(artifact, f"partition {key} concept artifact")
        assert_document_frequency_invariants(artifact, f"partition {key} concept artifact")
        version = save_partition_artifact(client, key, scope, artifact)
        readiness = global_partition_readiness(client)
        merged_artifact = None
        should_publish = selected["publishGlobally"] and readiness["complete"]
        if should_publish:
            merged_artifact = merge_partition_artifacts(client)
            log_merge_fanin(reporter, merged_artifact)
        reporter.report(
            "write_results", "Writing Versioned Results",
            detail=(
                f"Publishing {key} version {version} and merged dictionary."
                if should_publish
                else (
                    f"Storing isolated {key} version {version} without replacing the global dictionary."
                    if not selected["publishGlobally"]
                    else f"Storing {key} version {version}; {readiness['pending']} global partitions remain pending."
                )
            ),
            counts={
                "partition": key, "version": version, "concepts": len(concepts),
                "mergedConcepts": len(merged_artifact["concepts"]) if merged_artifact else None,
                "partitionsReady": readiness["ready"], "partitionsTotal": readiness["total"],
            },
        )
        if should_publish:
            upload_concept_artifact(merged_artifact)
            mark_global_published(client)
        elif not selected["publishGlobally"]:
            reporter.append_log(
                f"Stored custom partition {key} without changing the global concept artifact.\n"
            )
        else:
            reporter.append_log(
                f"Retained the current global artifact while {readiness['pending']} partitions are pending.\n"
            )
        result = {
            "partition": key, "partitionVersion": version, "partitions": readiness["total"],
            "documents": len(docs), "documentsChanged": len(changed_docs), "documentsReused": reused,
            "candidates": len(phrase_docs), "accepted": len(accepted_docs), "rejected": rejected_rank + rejected_gate,
            "concepts": len(concepts),
            "mergedConcepts": len(merged_artifact["concepts"]) if merged_artifact else None,
            "globalPublished": should_publish, "partitionsPending": readiness["pending"],
            "aliases": len(variant_to_canonical),
            "mergedAliases": merged_artifact["stats"]["aliases"] if merged_artifact else None,
            "failed": failures, "method": "patternrank_incremental", "model": MODEL_NAME,
        }
        reporter.report("complete", "Complete", status="completed", detail=f"Completed {key} version {version}.", counts=result)
        reporter.append_log(
            f"Incremental PatternRank completed {key}: {len(changed_docs)} changed, {reused} reused, {len(concepts)} partition concepts.\n"
        )
        reporter.finish("completed", result=result)
    except Exception as exc:
        message = str(exc)
        if selected and selected.get("key"):
            client.execute(
                "UPDATE concept_partitions SET status = 'failed', error = ?, updated_at = ? WHERE partition_key = ?",
                [message[:4000], utc_now(), selected["key"]],
            )
        reporter.append_log(f"PatternRank concept rebuild failed: {message}\n")
        reporter.report("failed", "Failed", status="failed", detail=message)
        reporter.finish("failed", error=message)
        client.close()
        sys.exit(1)

    client.close()


if __name__ == "__main__":
    main()
