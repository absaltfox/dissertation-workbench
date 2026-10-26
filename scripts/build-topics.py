#!/usr/bin/env python3
"""BERTopic sidecar: discover latent topics from dissertation abstracts.

Reads abstracts from the SQLite database, runs BERTopic clustering, and writes
topic assignments back to the `topics` and `document_topics` tables.

Usage:
    pip install -r requirements.txt
    python scripts/build-topics.py
"""

import os
os.environ["OMP_NUM_THREADS"] = "1"
os.environ["MKL_NUM_THREADS"] = "1"
os.environ["OPENBLAS_NUM_THREADS"] = "1"
os.environ["VECLIB_MAXIMUM_THREADS"] = "1"
os.environ["NUMEXPR_NUM_THREADS"] = "1"
os.environ["TORCH_NUM_THREADS"] = "1"

try:
    import torch
    torch.set_num_threads(1)
except ImportError:
    pass

import gc
import json
import math
import re
import sqlite3
import argparse
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone

MODEL_NAME = "allenai/specter2_base"
CLAUDE_MODEL = "claude-haiku-4-5-20251001"
MIN_TOPIC_SIZE = 5  # increased from 3 for cleaner, more cohesive clusters
DB_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "metrics.sqlite")
MIN_TOPIC_SIZE_DOCS_PER_TOPIC = 700  # default min_topic_size scales as n_docs / 700 (20 at ~14k docs)
# Fixed seed so a rebuild over unchanged data and settings reproduces the same topics.
# Chosen once; never tune it to make results look better.
TOPIC_RANDOM_STATE = 42
# Merge clusters closer than this in UMAP space; a five-seed sweep (2026-10-25) showed
# 1-2 points fewer outliers and more stable assignments than 0.
HDBSCAN_CLUSTER_SELECTION_EPSILON = 0.1
MAX_MISMATCH_LOG_LINES = 5


def _positive_int_env(name):
    """Return env var `name` as a positive int, or None if unset/invalid (invalid warns)."""
    raw = os.environ.get(name, "").strip()
    if not raw:
        return None
    try:
        value = int(raw)
        if value > 0:
            return value
    except ValueError:
        pass
    print(f"Warning: ignoring invalid {name}={raw!r} (expected a positive integer)", file=sys.stderr)
    return None


def resolve_min_topic_size(n_docs):
    """BERTOPIC_MIN_TOPIC_SIZE if valid, else max(MIN_TOPIC_SIZE, round(n_docs / MIN_TOPIC_SIZE_DOCS_PER_TOPIC))."""
    override = _positive_int_env("BERTOPIC_MIN_TOPIC_SIZE")
    if override is not None:
        if override >= 2:
            return override
        print(f"Warning: ignoring BERTOPIC_MIN_TOPIC_SIZE={override} (HDBSCAN needs at least 2); using the default",
              file=sys.stderr)
    return max(MIN_TOPIC_SIZE, round(n_docs / MIN_TOPIC_SIZE_DOCS_PER_TOPIC))


# Topic-term vocabulary. These only shape c-TF-IDF terms (and the c-TF-IDF outlier
# step), never the embeddings.
TOPIC_ACADEMIC_STOP_WORDS = {
    "chapter", "study", "research", "thesis", "dissertation", "university",
    "ubc", "british", "columbia", "participants", "findings", "methodology",
    "results", "methods", "data", "analysis", "chapters", "approach",
    "participant", "abstract", "introduction", "conclusion",
    "my", "our", "we", "i",
}
# Function words for the corpus's other abstract languages (French, Spanish, Italian, German).
NON_ENGLISH_STOP_WORDS = {
    # French
    "le", "la", "les", "un", "une", "des", "du", "de", "au", "aux", "et", "ou", "mais", "donc",
    "car", "ni", "que", "qui", "quoi", "dont", "où", "ce", "cet", "cette", "ces", "se", "sa", "ses",
    "leur", "leurs", "mon", "ma", "mes", "notre", "nos", "votre", "vos", "il", "ils", "elle",
    "elles", "on", "nous", "vous", "je", "tu", "en", "dans", "par", "pour", "sur", "avec", "sans",
    "sous", "entre", "vers", "chez", "est", "sont", "être", "été", "était", "ont", "avoir", "pas",
    "ne", "plus", "aussi", "comme", "très", "tout", "tous", "toute", "toutes", "autre", "autres",
    "même", "cela", "ceci", "ainsi", "lors", "selon", "afin", "peut", "son", "deux", "fait",
    # French elisions as they appear once apostrophes are stripped (d'un -> dun, c'est -> cest)
    "dun", "dune", "cest", "quil", "quils", "quelle", "quelles", "quon", "nest", "sest", "lon",
    # Spanish
    "el", "los", "las", "una", "unos", "unas", "del", "al", "en", "con", "por", "para", "sobre",
    "como", "más", "pero", "su", "sus", "lo", "es", "está", "están", "ser", "fue", "fueron", "ha",
    "han", "hay", "este", "esta", "estos", "estas", "ese", "esa", "esos", "esas", "muy", "también",
    "ya", "desde", "hasta", "donde", "cuando", "porque", "cual", "cuales", "nos", "mi",
    # Italian
    "lo", "gli", "uno", "di", "da", "per", "tra", "fra", "ed", "che", "chi", "non", "della",
    "dei", "delle", "degli", "alla", "alle", "dal", "dalla", "nel", "nella", "nei", "sul", "sulla",
    "è", "sono", "più", "anche", "ma", "suo", "sua", "suoi", "sue", "questo", "questa", "questi",
    "queste", "quello", "quella", "essere", "stato",
    # German
    "der", "das", "den", "dem", "des", "ein", "eine", "einer", "eines", "einem", "einen", "und",
    "oder", "aber", "nicht", "mit", "von", "zu", "zur", "zum", "im", "auf", "für", "aus", "bei",
    "nach", "über", "unter", "durch", "ist", "sind", "wird", "werden", "wurde", "sich", "auch",
    "als", "wie", "dass", "daß", "es", "er", "sie", "wir", "ihr", "ihre", "sein", "seine",
    "dieser", "diese", "dieses", "noch", "nur", "schon", "um",
}
# "Chapter" in each language, like the English academic list.
NON_ENGLISH_STOP_WORDS |= {"chapitre", "chapitres", "capítulo", "capitolo", "kapitel"}
# Leftovers of formulas stripped from mathematics abstracts.
PLACEHOLDER_STOP_WORDS = {"omitted", "superscript", "subscript", "let"}
# Foreign function words that are also meaningful English topic terms.
ENGLISH_HOMOGRAPHS_TO_KEEP = {"war", "die", "sin", "era", "come", "art", "man", "ai", "eu"}
# Letters only, two or more: keeps "eu"/"ai", drops "05", "1990s" and "x2".
TOPIC_TOKEN_PATTERN = r"(?u)\b[^\W\d_]{2,}\b"


def topic_extra_stop_words():
    """Stop words added to scikit-learn's English list for topic terms."""
    words = TOPIC_ACADEMIC_STOP_WORDS | NON_ENGLISH_STOP_WORDS | PLACEHOLDER_STOP_WORDS
    return words - ENGLISH_HOMOGRAPHS_TO_KEEP


def build_topic_vectorizer():
    """CountVectorizer for BERTopic's topic terms (English + extra stop words, letters-only tokens)."""
    from sklearn.feature_extraction import text
    from sklearn.feature_extraction.text import CountVectorizer
    stop_words = sorted(text.ENGLISH_STOP_WORDS.union(topic_extra_stop_words()))
    return CountVectorizer(stop_words=stop_words, token_pattern=TOPIC_TOKEN_PATTERN)


def cluster_model_params(min_topic_size):
    """Return (umap_kwargs, hdbscan_kwargs) for the BERTopic clustering fit.

    UMAP uses BERTopic's default shape with the shared seed; HDBSCAN keeps
    min_samples=1 and merges clusters closer than HDBSCAN_CLUSTER_SELECTION_EPSILON.
    """
    umap_kwargs = {
        "n_neighbors": 15,
        "n_components": 5,
        "min_dist": 0.0,
        "metric": "cosine",
        "random_state": TOPIC_RANDOM_STATE,
    }
    hdbscan_kwargs = {
        "min_cluster_size": min_topic_size,
        "min_samples": 1,
        "metric": "euclidean",
        "cluster_selection_epsilon": HDBSCAN_CLUSTER_SELECTION_EPSILON,
        "prediction_data": True,
    }
    return umap_kwargs, hdbscan_kwargs


def resolve_max_topics():
    """BERTOPIC_MAX_TOPICS (positive int) or None for no cap."""
    value = _positive_int_env("BERTOPIC_MAX_TOPICS")
    if value is not None and value < 2:
        print(f"Warning: ignoring BERTOPIC_MAX_TOPICS={value} (needs at least 2); no cap applied", file=sys.stderr)
        return None
    return value


def refresh_topic_representation(topic_model, docs, topics, vectorizer_model):
    """Recompute topic representations while keeping the stop-word vectorizer.

    BERTopic's update_topics() falls back to a default CountVectorizer when
    vectorizer_model is omitted, which silently drops the stop-word list.
    """
    topic_model.update_topics(docs, topics=topics, vectorizer_model=vectorizer_model)


# DB connection and logging utilities
class SqliteClientWrapper:
    def __init__(self, db_path):
        self.conn = sqlite3.connect(db_path)
        self.conn.row_factory = sqlite3.Row
        
    def execute(self, sql, params=None):
        cursor = self.conn.cursor()
        # standard sqlite3 execute expects tuple or dict, but libsql-client accepts lists
        p = tuple(params) if params is not None else ()
        cursor.execute(sql, p)
        
        class ResultSet:
            def __init__(self, cursor):
                self.rows = cursor.fetchall()
                self.columns = [d[0] for d in cursor.description] if cursor.description else []
        
        self.conn.commit()
        return ResultSet(cursor)
    
    def batch(self, statements):
        """Run (sql, params) statements in one transaction; roll back all on error."""
        try:
            for sql, params in statements:
                self.conn.execute(sql, tuple(params) if params is not None else ())
            self.conn.commit()
        except Exception:
            self.conn.rollback()
            raise

    def close(self):
        self.conn.close()


def retry_with_backoff(fn, what, retries=3):
    """Call fn(), retrying with exponential backoff (0.5s, 1s, 2s, ...) up to `retries` times.

    Re-raises the last error once the retries are exhausted. `what` names the
    operation in the retry log line.
    """
    for attempt in range(retries + 1):
        try:
            return fn()
        except Exception as ex:
            if attempt >= retries:
                raise
            delay = 0.5 * (2 ** attempt)
            print(f"  {what} failed (attempt {attempt + 1}/{retries + 1}): {ex}; retrying in {delay}s",
                  file=sys.stderr)
            time.sleep(delay)


def write_statements(client, statements, chunk=500, retries=3):
    """Run (sql, params) statements in order via client.batch, `chunk` statements per transaction.

    Works on SqliteClientWrapper and libsql_client sync clients (both accept
    (sql, params) tuples). Each chunk is retried with exponential backoff
    (0.5s, 1s, 2s, ...) up to `retries` times, then the error is re-raised.
    """
    for start in range(0, len(statements), chunk):
        part = [(sql, list(params)) for sql, params in statements[start:start + chunk]]
        retry_with_backoff(
            lambda: client.batch(part),
            f"Batch write (rows {start}-{start + len(part) - 1})",
            retries,
        )


def write_rows(client, sql, rows, chunk=500, retries=3):
    """Write parameter lists for one statement via write_statements."""
    write_statements(client, [(sql, params) for params in rows], chunk=chunk, retries=retries)


# Live topic tables and their column definitions. Results are written to
# "<name>_next" staging tables and swapped in with one transaction, so a failed
# or interrupted job never leaves the live tables empty or half-written.
# Table names are hard-coded constants (never built from external input).
TOPIC_TABLE_SCHEMAS = {
    "topics": (
        "topic_id INTEGER PRIMARY KEY, label TEXT NOT NULL, top_terms TEXT NOT NULL, "
        "doc_count INTEGER NOT NULL, model_name TEXT NOT NULL, created_at TEXT NOT NULL"
    ),
    "document_topics": (
        "doc_id TEXT NOT NULL, topic_id INTEGER NOT NULL, probability REAL, "
        "PRIMARY KEY (doc_id, topic_id)"
    ),
    "topic_hierarchy_meta": (
        "id INTEGER PRIMARY KEY DEFAULT 1, leaf_topic_ids TEXT NOT NULL, "
        "linkage_json TEXT NOT NULL, created_at TEXT NOT NULL"
    ),
    "document_topic_coords": (
        "doc_id TEXT PRIMARY KEY, umap_x REAL NOT NULL, umap_y REAL NOT NULL"
    ),
}
TOPIC_TABLE_COLUMNS = {
    "topics": ["topic_id", "label", "top_terms", "doc_count", "model_name", "created_at"],
    "document_topics": ["doc_id", "topic_id", "probability"],
    "topic_hierarchy_meta": ["id", "leaf_topic_ids", "linkage_json", "created_at"],
    "document_topic_coords": ["doc_id", "umap_x", "umap_y"],
}


def ensure_live_topic_tables(client):
    for name, schema in TOPIC_TABLE_SCHEMAS.items():
        client.execute(f"CREATE TABLE IF NOT EXISTS {name} ({schema})")


def prepare_staging_topic_tables(client):
    """Create the staging tables (same schema as live) and empty them."""
    for name, schema in TOPIC_TABLE_SCHEMAS.items():
        client.execute(f"CREATE TABLE IF NOT EXISTS {name}_next ({schema})")
        client.execute(f"DELETE FROM {name}_next")


def drop_staging_topic_tables(client):
    """Best-effort cleanup of the staging tables; never raises."""
    for name in TOPIC_TABLE_SCHEMAS:
        try:
            client.execute(f"DROP TABLE IF EXISTS {name}_next")
        except Exception as ex:
            print(f"  Warning: could not drop {name}_next: {ex}", file=sys.stderr)


def staging_swap_committed(client, now):
    """After a swap exception, True if the swap actually committed (response lost).

    The swap drops topics_next inside its transaction, so its absence suggests
    the transaction committed; we also require the live `topics` rows to carry
    this run's `created_at` (`now`), so a stray missing staging table cannot be
    mistaken for a commit. If the check itself fails, return False (keep the failure).
    """
    try:
        rows = client.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'topics_next'"
        ).rows
        if len(rows) != 0:
            return False
        live = client.execute("SELECT 1 AS ok FROM topics WHERE created_at = ? LIMIT 1", [now]).rows
        return len(live) > 0
    except Exception:
        return False


TOPICS_GENERATION_KEY = "topics_generation"


def publish_staged_topics(client, now):
    """Swap staged rows into the live topic tables in ONE transaction.

    For each table: DELETE live, INSERT live from staging (explicit columns),
    DROP staging. The same transaction bumps the `topics_generation` setting to
    `now` so web processes can invalidate cached topic slices. If any statement
    fails the whole batch rolls back and the live tables keep their previous rows.
    Refuses to swap (raises) when staged topics or assignments are empty.
    """
    for name in ("topics_next", "document_topics_next"):
        n = client.execute(f"SELECT COUNT(*) AS c FROM {name}").rows[0]["c"]
        if not n:
            raise RuntimeError(f"Refusing to publish: staging table {name} is empty")
    client.execute(
        "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT NOT NULL)"
    )
    statements = []
    for name, columns in TOPIC_TABLE_COLUMNS.items():
        cols = ", ".join(columns)
        statements.append((f"DELETE FROM {name}", []))
        statements.append((f"INSERT INTO {name} ({cols}) SELECT {cols} FROM {name}_next", []))
        statements.append((f"DROP TABLE {name}_next", []))
    statements.append((
        "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        [TOPICS_GENERATION_KEY, now, now],
    ))
    client.batch(statements)


EMBEDDING_PAGE_SIZE = 500  # 500 x 768-float JSON is ~7 MB per Turso response


def load_cached_embeddings(client, doc_ids, page_size=EMBEDDING_PAGE_SIZE):
    """Load cached embeddings for doc_ids into a float32 matrix using keyset pagination.

    Returns (matrix, filled_mask, dim). Row i of matrix belongs to doc_ids[i];
    filled_mask[i] is True when a usable cached vector was loaded for it. Rows
    whose dimension differs from the first cached vector are treated as missing.
    If nothing is cached, returns (None, filled_mask of all False, None) and the
    caller allocates the matrix once it knows the dimension.
    """
    import numpy as np

    indices_by_doc = {}
    for idx, doc_id in enumerate(doc_ids):
        indices_by_doc.setdefault(doc_id, []).append(idx)
    filled = np.zeros(len(doc_ids), dtype=bool)
    matrix = None
    dim = None
    mismatched = 0
    malformed = 0
    last_id = ""
    while True:
        res = retry_with_backoff(
            lambda: client.execute(
                "SELECT doc_id, embedding FROM document_embeddings WHERE doc_id > ? ORDER BY doc_id LIMIT ?",
                [last_id, page_size],
            ),
            f"Embedding page read (after {last_id!r})",
        )
        rows = res.rows
        if not rows:
            break
        last_id = rows[-1]["doc_id"]
        for row in rows:
            targets = indices_by_doc.get(row["doc_id"])
            if not targets:
                continue
            try:
                vec = json.loads(row["embedding"])
                if not isinstance(vec, list):
                    raise ValueError("not a JSON array")
            except (ValueError, TypeError) as ex:
                malformed += 1
                if malformed <= MAX_MISMATCH_LOG_LINES:
                    print(f"  Ignoring malformed cached embedding for {row['doc_id']}: {ex}")
                continue
            if dim is None:
                dim = len(vec)
                matrix = np.empty((len(doc_ids), dim), dtype=np.float32)
            if len(vec) != dim:
                mismatched += 1
                if mismatched <= MAX_MISMATCH_LOG_LINES:
                    print(f"  Ignoring cached embedding for {row['doc_id']}: dimension {len(vec)} != {dim}")
                continue
            for idx in targets:
                matrix[idx] = vec
                filled[idx] = True
        n_rows = len(rows)
        del rows, res
        if n_rows < page_size:
            break
    if mismatched:
        print(f"  {mismatched} cached embeddings had a mismatched dimension and will be re-encoded.")
    if malformed:
        print(f"  {malformed} cached embeddings were malformed and will be re-encoded.")
    return matrix, filled, dim


class DatabaseLogger:
    def __init__(self, client, job_id, original_stdout, execution_id):
        self.client = client
        self.job_id = int(job_id)
        self.original_stdout = original_stdout
        self.execution_id = execution_id
        self.buffer = ""
        self.lock = threading.Lock()
        self.thread = threading.Thread(target=self._flush_loop, daemon=True)
        self.thread.start()
        
    def write(self, text):
        self.original_stdout.write(text)
        self.original_stdout.flush()
        with self.lock:
            self.buffer += text
            
    def flush(self):
        self.original_stdout.flush()
        self._flush_to_db()
        
    def _flush_to_db(self):
        with self.lock:
            if not self.buffer:
                return
            text_to_write = self.buffer
            self.buffer = ""
            
        try:
            self.client.execute(
                "UPDATE admin_jobs SET log = COALESCE(log, '') || ? "
                "WHERE id = ? AND execution_id = ? AND status = 'running' AND finished_at IS NULL",
                [text_to_write, self.job_id, self.execution_id]
            )
        except Exception as e:
            self.original_stdout.write(f"\n[Logger Error] Failed to write log to DB: {e}\n")
            
    def _flush_loop(self):
        while True:
            time.sleep(3)
            self._flush_to_db()


class ProgressReporter:
    def __init__(self, client, job_id, execution_id=None):
        self.client = client
        self.job_id = int(job_id) if job_id else None
        self.execution_id = execution_id
        self.tasks = []
        self.task_index = {}

    def report(self, key, label=None, status="running", detail=None, counts=None, next_task=None):
        if not self.job_id:
            return
        label = label or key
        task = {
            "key": key,
            "label": label,
            "status": status,
            "detail": detail,
            "counts": counts,
            "updatedAt": datetime.now(timezone.utc).isoformat()
        }
        if key in self.task_index:
            self.tasks[self.task_index[key]] = task
        else:
            self.task_index[key] = len(self.tasks)
            self.tasks.append(task)
        
        current_task = next_task if (status == "completed" and next_task) else label
        progress_data = {
            "phase": key,
            "currentTask": current_task,
            "tasks": self.tasks,
            "counts": counts
        }
        
        try:
            now_str = datetime.now(timezone.utc).isoformat()
            self.client.execute(
                "UPDATE admin_jobs SET progress_json = ?, runner_state = ?, heartbeat_at = ? "
                "WHERE id = ? AND execution_id = ? AND status = 'running' AND finished_at IS NULL",
                [json.dumps(progress_data), current_task, now_str, self.job_id, self.execution_id]
            )
        except Exception as e:
            sys.stderr.write(f"\n[Progress Error] Failed to update progress in DB: {e}\n")


def get_db_client(db_path):
    url = os.environ.get("TURSO_DATABASE_URL", "").strip()
    auth_token = os.environ.get("TURSO_AUTH_TOKEN", "").strip()
    if url:
        if url.startswith("libsql://"):
            url = "https://" + url[len("libsql://"):]
        import libsql_client
        print(f"Connecting to remote Turso database: {url}")
        return libsql_client.create_client_sync(url, auth_token=auth_token)
    else:
        print(f"Connecting to local SQLite database: {db_path}")
        return SqliteClientWrapper(db_path)


GENERIC_LABEL_KEYS = {
    "academic category title",
    "category title",
    "education research",
    "educational research",
    "educational research themes",
    "global & intercultural educational studies",
    "global intercultural educational studies",
    "global and intercultural educational studies",
    "research topic",
    "research topics",
    "short category title",
    "topic label",
    "topic title",
}


def normalize_label_key(label):
    return re.sub(r"\s+", " ", str(label or "").strip().lower())


def clean_generated_label(label):
    if label is None:
        return None

    cleaned = str(label).strip()
    if not cleaned:
        return None

    # Some small local models echo a whole instruction or multiple lines.
    lines = [line.strip() for line in cleaned.splitlines() if line.strip()]
    cleaned = lines[0] if lines else cleaned
    cleaned = re.sub(r"^(topic\s*-?\d+\s*[:\-]\s*|label\s*[:\-]\s*)", "", cleaned, flags=re.IGNORECASE)
    cleaned = cleaned.strip(" \t\r\n\"'`.,;:")
    cleaned = re.sub(r"\s+", " ", cleaned)

    key = normalize_label_key(cleaned)
    if len(cleaned) < 3 or key in GENERIC_LABEL_KEYS:
        return None
    return cleaned


def titleize_terms(terms):
    words = []
    for term in terms:
        cleaned = re.sub(r"[_\-]+", " ", str(term)).strip()
        cleaned = re.sub(r"\s+", " ", cleaned)
        if cleaned:
            words.append(cleaned)
    if not words:
        return None
    return " ".join(words[:4]).title()


def bertopic_default_label(topic_model, topic_id, row=None):
    if topic_id == -1:
        return "Uncategorized"

    terms = topic_model.get_topic(topic_id) or []
    if isinstance(terms, list):
        label = titleize_terms([term for term, _weight in terms[:4]])
        if label:
            return label

    if row is not None:
        name = str(row.get("Name", "")).strip()
        if "_" in name:
            return titleize_terms(name.split("_")[1:]) or f"Topic {topic_id}"
        cleaned = clean_generated_label(name)
        if cleaned:
            return cleaned

    return f"Topic {topic_id}"


def unique_label(label, topic_id, used_keys):
    key = normalize_label_key(label)
    if key not in used_keys:
        used_keys.add(key)
        return label

    candidate = f"{label} Topic {topic_id}"
    key = normalize_label_key(candidate)
    suffix = 2
    while key in used_keys:
        candidate = f"{label} Topic {topic_id}-{suffix}"
        key = normalize_label_key(candidate)
        suffix += 1
    used_keys.add(key)
    return candidate


def label_is_usable(label, used_keys=None):
    cleaned = clean_generated_label(label)
    if not cleaned:
        return False
    if used_keys and normalize_label_key(cleaned) in used_keys:
        return False
    return True


def build_topic_label_map(topic_model, topic_info, generated_labels):
    """Return safe per-topic labels, replacing duplicate model outputs only as a last resort."""
    label_map = {}
    generated_by_key = {}

    for _, row in topic_info.iterrows():
        topic_id = int(row["Topic"])
        if topic_id == -1:
            label_map[topic_id] = "Uncategorized"
            continue

        label = clean_generated_label(generated_labels.get(topic_id))
        if label:
            generated_by_key.setdefault(normalize_label_key(label), []).append(topic_id)
        label_map[topic_id] = label

    duplicate_generated_ids = {
        topic_id
        for topic_ids in generated_by_key.values()
        if len(topic_ids) > 1
        for topic_id in topic_ids
    }

    if duplicate_generated_ids:
        print(
            f"  Replacing {len(duplicate_generated_ids)} duplicate generated labels "
            "with per-topic fallback labels"
        )

    used_keys = {normalize_label_key("Uncategorized")}
    for _, row in topic_info.iterrows():
        topic_id = int(row["Topic"])
        if topic_id == -1:
            continue

        label = label_map.get(topic_id)
        if not label or topic_id in duplicate_generated_ids:
            label = bertopic_default_label(topic_model, topic_id, row)
        label_map[topic_id] = unique_label(label, topic_id, used_keys)

    return label_map


def generate_labels(topic_model, abstracts, topic_assignments, reporter=None):
    """Generate human-readable topic labels using Claude (if API key set) or a local Qwen model."""
    api_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if api_key:
        labels = generate_claude_labels(topic_model, abstracts, topic_assignments, api_key, reporter)
        if labels and len(labels) > 1:
            return labels
    return generate_local_labels(topic_model, abstracts, topic_assignments, reporter)


def generate_claude_labels(topic_model, abstracts, topic_assignments, api_key, reporter=None):
    """Use Claude to generate human-readable topic labels."""
    try:
        import anthropic
    except ImportError:
        print("\nanthropic package not installed — skipping Claude label generation")
        return {}

    client = anthropic.Anthropic(api_key=api_key)
    topic_info = topic_model.get_topic_info()
    labels = {}

    # Build all topic descriptions into a single batch prompt
    topic_descriptions = []
    topic_ids_in_batch = []

    for _, row in topic_info.iterrows():
        topic_id = int(row["Topic"])
        if topic_id == -1:
            labels[-1] = "Uncategorized"
            continue

        # Get top terms
        terms = topic_model.get_topic(topic_id)
        if not terms:
            continue
        top_words = [t[0] for t in terms[:10]]

        # Get representative abstracts (up to 3, truncated)
        doc_indices = [i for i, t in enumerate(topic_assignments) if t == topic_id][:3]
        sample_abstracts = [abstracts[i][:300] for i in doc_indices]

        topic_descriptions.append(
            f"TOPIC {topic_id}:\n"
            f"  Keywords: {', '.join(top_words)}\n"
            f"  Sample abstracts:\n"
            + "\n".join(f"    - {a}..." for a in sample_abstracts)
        )
        topic_ids_in_batch.append(topic_id)

    if not topic_descriptions:
        return labels

    total_topics = len(topic_ids_in_batch)
    if reporter:
        reporter.report(
            "generate_labels",
            "Generating Labels",
            status="running",
            detail=f"Requesting labels for {total_topics} topics from Claude...",
            counts={"processed": 0, "total": total_topics}
        )

    prompt = (
        f"You are labeling topics discovered by clustering {len(abstracts)} Education doctoral dissertation abstracts "
        "from UBC (University of British Columbia). For each topic below, generate a short, descriptive "
        "label (3-6 words) that captures the core research theme. The label should be a noun phrase "
        "(e.g. 'Indigenous Education Policy', 'Teacher Identity & Resilience', 'Reading Comprehension Assessment').\n\n"
        "Respond with ONLY a JSON object mapping topic ID (as string) to label. No other text.\n\n"
        + "\n\n".join(topic_descriptions)
    )

    print(f"\nGenerating labels for {len(topic_ids_in_batch)} topics via Claude ({CLAUDE_MODEL})...")

    try:
        response = client.messages.create(
            model=CLAUDE_MODEL,
            max_tokens=2048,
            messages=[{"role": "user", "content": prompt}],
        )
        text = response.content[0].text.strip()
        # Parse JSON from response (handle markdown code blocks)
        if text.startswith("```"):
            text = text.split("\n", 1)[1].rsplit("```", 1)[0].strip()
        parsed = json.loads(text)
        for tid_str, label in parsed.items():
            labels[int(tid_str)] = str(label)
        print(f"  Generated {len(parsed)} labels successfully")
        
        if reporter:
            reporter.report(
                "generate_labels",
                "Generating Labels",
                status="completed",
                detail=f"Successfully generated {len(parsed)} labels via Claude.",
                counts={"processed": total_topics, "total": total_topics},
                next_task="Saving Results"
            )
    except Exception as e:
        print(f"\nWarning: Claude label generation failed: {e}", file=sys.stderr)
        if reporter:
            reporter.report(
                "generate_labels",
                "Generating Labels",
                status="failed",
                detail=f"Claude label generation failed: {e}",
                counts={"processed": 0, "total": total_topics}
            )
        return {}

    return labels


def generate_llama_cpp_labels(topic_model, abstracts, topic_assignments, reporter=None):
    model_path = os.environ.get("LOCAL_LABEL_MODEL_PATH", "/app/models/qwen2.5-1.5b-instruct-q4.gguf")
    command = os.environ.get("LLAMA_CPP_COMMAND", "llama-cli")
    if not os.path.exists(model_path):
        print(f"llama.cpp model not found at {model_path}; falling back to transformers")
        return {}

    topic_info = topic_model.get_topic_info()
    labels = {-1: "Uncategorized"}
    used_label_keys = {normalize_label_key("Uncategorized")}
    total_topics = len(topic_info) - 1
    processed_count = 0
    print(f"Generating labels for {total_topics} topics with llama.cpp ({model_path})...")

    for _, row in topic_info.iterrows():
        topic_id = int(row["Topic"])
        if topic_id == -1:
            continue
        if reporter:
            reporter.report(
                "generate_labels",
                "Generating Labels",
                status="running",
                detail=f"Generating llama.cpp label for topic {topic_id} ({processed_count + 1}/{total_topics})...",
                counts={"processed": processed_count, "total": total_topics}
            )
        terms = clean_topic_terms(topic_model.get_topic(topic_id))[:10]
        fallback = bertopic_default_label(topic_model, topic_id, row)
        doc_indices = [i for i, t in enumerate(topic_assignments) if int(t) == topic_id][:3]
        samples = [re.sub(r"\s+", " ", abstracts[i]).strip()[:260] for i in doc_indices]
        prompt = (
            "You are an academic librarian. Write one concise, human-readable research topic label.\n"
            f"Top terms: {', '.join(terms)}\n"
            f"Rough machine phrase, not final: {fallback}\n"
            "Representative documents:\n"
            + "\n".join(f"- {sample}" for sample in samples)
            + "\nRules: return only one natural 3 to 6 word noun phrase. Do not list keywords. Label:"
        )
        try:
            result = subprocess.run(
                [
                    command,
                    "-m", model_path,
                    "-p", prompt,
                    "-n", "24",
                    "--temp", "0.35",
                    "--top-p", "0.9",
                    "--no-display-prompt",
                ],
                check=True,
                capture_output=True,
                text=True,
                timeout=120,
            )
            response = clean_generated_label(result.stdout.strip())
        except Exception as exc:
            print(f"  Topic {topic_id} llama.cpp generation failed: {exc}")
            response = None

        label, _score, _warnings = score_label_candidate(response, topic_id, fallback, used_label_keys)
        if not label:
            label = fallback
        used_label_keys.add(normalize_label_key(label))
        labels[topic_id] = label
        print(f"  Topic {topic_id} -> {label} (llama.cpp)", flush=True)
        processed_count += 1

    return labels


def generate_local_labels(topic_model, abstracts, topic_assignments, reporter=None):
    """Use a local LLM (Qwen/Qwen2.5-0.5B-Instruct by default) to generate topic labels."""
    if os.environ.get("LOCAL_LABEL_BACKEND", "").strip().lower() == "llama_cpp":
        labels = generate_llama_cpp_labels(topic_model, abstracts, topic_assignments, reporter)
        if labels and len(labels) > 1:
            return labels

    model_name = os.environ.get("LOCAL_LLM_MODEL", "Qwen/Qwen2.5-0.5B-Instruct")
    print(f"\nLoading local label generation model: {model_name}...")
    try:
        from transformers import AutoTokenizer, AutoModelForCausalLM
        import torch
        
        tokenizer = AutoTokenizer.from_pretrained(model_name)
        model = AutoModelForCausalLM.from_pretrained(model_name)
        
        # Enforce single-threaded CPU execution for inference
        torch.set_num_threads(1)
    except Exception as e:
        print(f"Failed to load local transformers model: {e}")
        return {}

    topic_info = topic_model.get_topic_info()
    labels = {}
    labels[-1] = "Uncategorized"
    used_label_keys = {normalize_label_key("Uncategorized")}

    total_topics = len(topic_info) - 1
    print(f"Generating labels for {total_topics} topics locally...")
    
    processed_count = 0
    for _, row in topic_info.iterrows():
        topic_id = int(row["Topic"])
        if topic_id == -1:
            continue

        if reporter:
            reporter.report(
                "generate_labels",
                "Generating Labels",
                status="running",
                detail=f"Generating local label for topic {topic_id} ({processed_count + 1}/{total_topics})...",
                counts={"processed": processed_count, "total": total_topics}
            )

        # Get top terms
        terms = topic_model.get_topic(topic_id)
        if not terms:
            continue
        top_words = [t[0] for t in terms[:10]]
        keyword_fallback_label = bertopic_default_label(topic_model, topic_id, row)
        prior_labels = [
            label
            for tid, label in sorted(labels.items())
            if tid != -1 and normalize_label_key(label) in used_label_keys
        ][-8:]

        # Get representative abstracts (up to 3, truncated)
        doc_indices = [i for i, t in enumerate(topic_assignments) if t == topic_id][:2]
        sample_abstracts = [abstracts[i][:180] for i in doc_indices]
        topic_context = (
            f"Topic ID: {topic_id}\n"
            f"Top weighted terms: {', '.join(top_words)}\n"
            f"Rough machine phrase, not final: {keyword_fallback_label}\n"
            f"Already used labels: {', '.join(prior_labels) if prior_labels else 'None'}\n"
            f"Representative abstracts:\n"
            + "\n".join(f"- {a}..." for a in sample_abstracts)
        )

        prompts = [
            (
                topic_context
                + "\n\nInstructions:\n"
                  "1. Find the core common research theme across these representative abstracts.\n"
                  "2. Write a short, clean, descriptive academic topic title as a natural noun phrase.\n"
                  "3. Use 3 to 6 words, with normal English connectors where needed.\n"
                  "4. Do not output a literal keyword list or a choppy sequence of search terms.\n"
                  "5. Do not reuse any already used label, and avoid broad catch-all labels.\n"
                  "6. Respond with ONLY the title. Do not include quotes, periods, or other text."
            ),
            (
                topic_context
                + "\n\nRewrite this as a polished topic legend label. "
                  "The label should sound like a library subject category, not raw BERTopic keywords. "
                  "Prefer phrasing like 'Teacher Identity and Practice', 'Policy Implementation in Schools', "
                  "or 'Indigenous Language Revitalization' when supported by the evidence. "
                  "Do not copy those examples unless they exactly fit this topic. "
                  "Do not reuse the rough machine phrase verbatim. "
                  "Return only one 3 to 6 word title."
            ),
        ]

        label = None
        source = None
        for attempt, prompt in enumerate(prompts):
            messages = [
                {"role": "system", "content": "You are an academic librarian creating concise, human-readable research topic labels. Return only one natural noun phrase, with no quotes and no commentary."},
                {"role": "user", "content": prompt}
            ]

            text = tokenizer.apply_chat_template(
                messages,
                tokenize=False,
                add_generation_prompt=True
            )
            model_inputs = tokenizer([text], return_tensors="pt")

            generate_kwargs = {
                "max_new_tokens": 18,
                "pad_token_id": tokenizer.eos_token_id,
                "no_repeat_ngram_size": 2,
            }
            if attempt == 0:
                generate_kwargs["do_sample"] = False
            else:
                generate_kwargs.update({"do_sample": True, "temperature": 0.7, "top_p": 0.9})

            generated_ids = model.generate(
                model_inputs.input_ids,
                attention_mask=model_inputs.get("attention_mask"),
                **generate_kwargs
            )
            generated_ids = [
                output_ids[len(input_ids):] for input_ids, output_ids in zip(model_inputs.input_ids, generated_ids)
            ]

            response = tokenizer.batch_decode(generated_ids, skip_special_tokens=True)[0].strip()
            response = clean_generated_label(response)
            if normalize_label_key(response) == normalize_label_key(keyword_fallback_label):
                response = None
            if label_is_usable(response, used_label_keys):
                label = response
                source = "Qwen" if attempt == 0 else "Qwen retry"
                break

        if not label:
            label = unique_label(keyword_fallback_label, topic_id, used_label_keys)
            source = "keyword fallback"

        if source in ("Qwen", "Qwen retry"):
            used_label_keys.add(normalize_label_key(label))

        print(f"  Topic {topic_id} -> {label} ({source})", flush=True)
        labels[topic_id] = label
        processed_count += 1

    if reporter:
        reporter.report(
            "generate_labels",
            "Generating Labels",
            status="completed",
            detail=f"Successfully generated {total_topics} local labels.",
            counts={"processed": total_topics, "total": total_topics},
            next_task="Saving Results"
        )

    del model
    del tokenizer
    import gc
    gc.collect()
    
    return labels


LABEL_STOP_WORDS = {
    "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "into",
    "is", "it", "my", "of", "on", "or", "our", "the", "their", "this", "to",
    "was", "we", "with", "study", "research", "thesis", "dissertation",
    "education", "university", "ubc", "british", "columbia", "data", "analysis",
}


def clean_topic_terms(topic_terms):
    cleaned = []
    for item in topic_terms or []:
        term = item[0] if isinstance(item, (list, tuple)) and item else item
        term = re.sub(r"\s+", " ", str(term or "").replace("_", " ")).strip()
        if len(term) < 3 or term.lower() in LABEL_STOP_WORDS:
            continue
        cleaned.append(term)
    return cleaned


def label_word_count(label):
    return len(re.findall(r"[A-Za-z][A-Za-z'’-]*", label or ""))


def looks_like_keyword_bag(label):
    if not label:
        return True
    if " / " in label:
        return True
    if "," in label:
        parts = [part.strip() for part in label.split(",") if part.strip()]
        has_final_conjunction = bool(re.search(r",\s*(and|or)\s+", label, re.I))
        if len(parts) > 3 or not has_final_conjunction:
            return True
    words = re.findall(r"[A-Za-z][A-Za-z'’-]*", label)
    if len(words) >= 4 and not re.search(r"\b(and|of|in|for|with|through|across|among|on)\b", label, re.I):
        return True
    return False


def score_label_candidate(label, topic_id, fallback_label=None, used_keys=None):
    warnings = []
    cleaned = clean_generated_label(label)
    if not cleaned:
        return None, 0, ["empty_or_generic"]
    key = normalize_label_key(cleaned)
    score = 100
    if used_keys and key in used_keys:
        warnings.append("duplicate")
        score -= 60
    if fallback_label and key == normalize_label_key(fallback_label):
        warnings.append("matches_keyword_fallback")
        score -= 35
    wc = label_word_count(cleaned)
    if wc < 3:
        warnings.append("too_short")
        score -= 20
    if wc > 8 or len(cleaned) > 80:
        warnings.append("too_long")
        score -= 15
    if looks_like_keyword_bag(cleaned):
        warnings.append("keyword_like")
        score -= 30
    if key in GENERIC_LABEL_KEYS:
        warnings.append("generic")
        score -= 50
    return cleaned, max(score, 0), warnings


def label_content_terms(label):
    terms = []
    for term in re.findall(r"[A-Za-z][A-Za-z'’-]*", label or ""):
        normalized = term.lower().replace("’", "'")
        if len(normalized) < 3 or normalized in LABEL_STOP_WORDS:
            continue
        terms.append(normalized)
    return terms


def topic_text_support_count(label, evidence):
    label_terms = label_content_terms(label)
    if not label_terms:
        return 0
    support_count = 0
    documents = list((evidence or {}).get("documents") or [])
    if not documents:
        documents = [{"title": title, "abstract": ""} for title in (evidence or {}).get("titles", [])]
    if not documents:
        documents = [{"title": "", "abstract": abstract} for abstract in (evidence or {}).get("abstracts", [])]
    for doc in documents:
        text = f"{doc.get('title', '')} {doc.get('abstract', '')}".lower()
        matched = sum(1 for term in label_terms if term in text)
        if matched >= max(2, min(len(label_terms), 3)):
            support_count += 1
    return support_count


def evidence_quality_warnings(label, evidence):
    warnings = []
    doc_count = int((evidence or {}).get("docCount") or 0)
    if 0 < doc_count <= 10:
        warnings.append("small_topic_review")

    label_terms = label_content_terms(label)
    evidence_documents = list((evidence or {}).get("documents") or [])
    if not evidence_documents:
        evidence_documents = [{"title": title, "abstract": ""} for title in (evidence or {}).get("titles", [])]
    if not evidence_documents:
        evidence_documents = [{"title": "", "abstract": abstract} for abstract in (evidence or {}).get("abstracts", [])]
    evidence_count = len(evidence_documents)
    if evidence_count >= 3 and len(label_terms) >= 3:
        support_count = topic_text_support_count(label, evidence)
        minimum_support = max(2, math.ceil(evidence_count * 0.3))
        if support_count < minimum_support:
            warnings.append("low_label_coverage")

        title_support = []
        for title in (evidence or {}).get("titles", []):
            text = str(title or "").lower()
            matches = sum(1 for term in label_terms if term in text)
            if matches >= max(2, math.ceil(len(label_terms) * 0.6)):
                title_support.append(title)
        if len(title_support) == 1 and support_count <= 2:
            warnings.append("overfits_single_document")
    return warnings


def ensure_topic_label_tables(client):
    client.execute("""
        CREATE TABLE IF NOT EXISTS topic_label_runs (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          backend      TEXT NOT NULL,
          model_name   TEXT NOT NULL,
          status       TEXT NOT NULL,
          config_json  TEXT,
          error        TEXT,
          started_at   TEXT NOT NULL,
          finished_at  TEXT,
          generation   TEXT
        )
    """)
    client.execute("""
        CREATE TABLE IF NOT EXISTS topic_label_candidates (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id        INTEGER,
          topic_id      INTEGER NOT NULL,
          label         TEXT NOT NULL,
          source        TEXT NOT NULL,
          score         REAL NOT NULL DEFAULT 0,
          status        TEXT NOT NULL,
          warnings_json TEXT NOT NULL DEFAULT '[]',
          evidence_json TEXT NOT NULL DEFAULT '{}',
          created_at    TEXT NOT NULL
        )
    """)
    client.execute("""
        CREATE TABLE IF NOT EXISTS topic_label_overrides (
          topic_id     INTEGER PRIMARY KEY,
          label        TEXT NOT NULL,
          source       TEXT NOT NULL,
          candidate_id INTEGER,
          created_at   TEXT NOT NULL,
          updated_at   TEXT NOT NULL,
          generation   TEXT
        )
    """)
    for table in ("topic_label_runs", "topic_label_overrides"):
        try:
            client.execute(f"ALTER TABLE {table} ADD COLUMN generation TEXT")
        except Exception:
            pass  # column already exists


def load_topics_generation(client):
    try:
        rows = client.execute("SELECT value FROM settings WHERE key = 'topics_generation'").rows
        return rows[0]["value"] if rows else None
    except Exception:
        return None


def load_existing_topic_labels(client):
    labels = {}
    try:
        for row in client.execute("SELECT topic_id, label FROM topics").rows:
            labels[int(row["topic_id"])] = row["label"]
    except Exception:
        pass
    return labels


def load_topic_label_overrides(client, generation):
    overrides = {}
    if generation is None:
        return overrides
    try:
        for row in client.execute("SELECT topic_id, label FROM topic_label_overrides WHERE generation = ?", [generation]).rows:
            overrides[int(row["topic_id"])] = row["label"]
    except Exception:
        pass
    return overrides


def build_topic_evidence(topic_model, topic_id, abstracts, topic_assignments, titles_by_topic=None, existing_label=None, doc_count=None, documents_by_topic=None):
    terms = clean_topic_terms(topic_model.get_topic(topic_id))[:10]
    doc_indices = [i for i, t in enumerate(topic_assignments) if int(t) == int(topic_id)][:3]
    samples = []
    for i in doc_indices:
        text = abstracts[i]
        samples.append(re.sub(r"\s+", " ", text).strip()[:320])
    documents = (documents_by_topic or {}).get(topic_id, [])
    return {
        "terms": terms,
        "titles": (titles_by_topic or {}).get(topic_id, [])[:8],
        "abstracts": samples,
        "existingLabel": existing_label,
        "docCount": doc_count,
        "documents": documents[:8],
    }


def build_candidate_rows(topic_model, topic_info, generated_labels, abstracts, topic_assignments, existing_labels=None, titles_by_topic=None, documents_by_topic=None):
    candidates_by_topic = {}
    used_keys = {normalize_label_key("Uncategorized")}
    for _, row in topic_info.iterrows():
        topic_id = int(row["Topic"])
        if topic_id == -1:
            continue
        fallback = bertopic_default_label(topic_model, topic_id, row)
        evidence = build_topic_evidence(
            topic_model, topic_id, abstracts, topic_assignments,
            titles_by_topic=titles_by_topic,
            existing_label=(existing_labels or {}).get(topic_id),
            doc_count=int(row.get("Count") or 0),
            documents_by_topic=documents_by_topic,
        )
        raw_candidates = [
            (generated_labels.get(topic_id), "qwen"),
            ((existing_labels or {}).get(topic_id), "previous"),
            (fallback, "keyword_fallback"),
        ]
        rows = []
        seen = set()
        for raw_label, source in raw_candidates:
            label, score, warnings = score_label_candidate(raw_label, topic_id, fallback, used_keys)
            if not label:
                continue
            coverage_warnings = evidence_quality_warnings(label, evidence)
            for warning in coverage_warnings:
                if warning not in warnings:
                    warnings.append(warning)
            if coverage_warnings:
                score = max(score - 25, 0)
            key = normalize_label_key(label)
            if key in seen:
                continue
            seen.add(key)
            rows.append({
                "topic_id": topic_id,
                "label": label,
                "source": source,
                "score": score,
                "warnings": warnings,
                "evidence": evidence,
            })
        rows.sort(key=lambda item: item["score"], reverse=True)
        if rows:
            used_keys.add(normalize_label_key(rows[0]["label"]))
        candidates_by_topic[topic_id] = rows
    return candidates_by_topic


def save_topic_label_candidates(client, candidates_by_topic, backend, model_name, config=None, generation=None):
    ensure_topic_label_tables(client)
    now = datetime.now(timezone.utc).isoformat()
    result = client.execute(
        "INSERT INTO topic_label_runs (backend, model_name, status, config_json, started_at, generation) VALUES (?, ?, 'completed', ?, ?, ?)",
        [backend, model_name, json.dumps(config or {}), now, generation]
    )
    run_id = getattr(result, "last_insert_rowid", None) or getattr(result, "lastInsertRowid", None)
    if not run_id:
        row = client.execute("SELECT MAX(id) AS id FROM topic_label_runs").rows[0]
        run_id = int(row["id"])

    statements = []
    for topic_id, rows in candidates_by_topic.items():
        statements.append((
            "UPDATE topic_label_candidates SET status = 'rejected' WHERE topic_id = ? AND status = 'pending'",
            [topic_id],
        ))
        for row in rows:
            statements.append((
                """
                INSERT INTO topic_label_candidates
                  (run_id, topic_id, label, source, score, status, warnings_json, evidence_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    int(run_id), topic_id, row["label"], row["source"], float(row["score"]), "pending",
                    json.dumps(row["warnings"]), json.dumps(row["evidence"]), now
                ],
            ))
    write_statements(client, statements)
    return int(run_id)


def choose_topic_labels(topic_model, topic_info, candidates_by_topic, overrides=None, existing_labels=None):
    labels = {-1: "Uncategorized"}
    for _, row in topic_info.iterrows():
        topic_id = int(row["Topic"])
        if topic_id == -1:
            continue
        if overrides and overrides.get(topic_id):
            labels[topic_id] = overrides[topic_id]
            continue
        passing = [
            candidate for candidate in candidates_by_topic.get(topic_id, [])
            if candidate["score"] >= 80 and not candidate["warnings"]
        ]
        if passing:
            labels[topic_id] = passing[0]["label"]
            continue
        previous = clean_generated_label((existing_labels or {}).get(topic_id))
        if previous:
            labels[topic_id] = previous
        else:
            labels[topic_id] = bertopic_default_label(topic_model, topic_id, row)
    return labels


def mark_auto_selected_candidates(client, candidates_by_topic, labels, overrides=None):
    statements = []
    for topic_id, label in labels.items():
        if topic_id == -1 or (overrides and overrides.get(topic_id)):
            continue
        for candidate in candidates_by_topic.get(topic_id, []):
            if normalize_label_key(candidate["label"]) == normalize_label_key(label) and candidate["score"] >= 80 and not candidate["warnings"]:
                statements.append((
                    "UPDATE topic_label_candidates SET status = 'auto_selected' WHERE topic_id = ? AND label = ? AND status = 'pending'",
                    [topic_id, candidate["label"]],
                ))
                break
    write_statements(client, statements)


class ExistingTopicInfo:
    def __init__(self, rows):
        self.rows = rows

    def iterrows(self):
        for idx, row in enumerate(self.rows):
            yield idx, row

    def __len__(self):
        return len(self.rows)


class ExistingTopicModel:
    def __init__(self, topic_terms, topic_info):
        self.topic_terms = topic_terms
        self.topic_info = topic_info

    def get_topic(self, topic_id):
        return self.topic_terms.get(int(topic_id), [])

    def get_topic_info(self):
        return self.topic_info


def parse_top_terms(value):
    try:
        parsed = json.loads(value or "[]")
    except Exception:
        return []
    terms = []
    for item in parsed:
        if isinstance(item, (list, tuple)) and item:
            weight = item[1] if len(item) > 1 else 0
            terms.append((str(item[0]), float(weight or 0)))
    return terms


def run_label_only(client, topic_id=None, reporter=None):
    ensure_topic_label_tables(client)
    topic_rows = client.execute("SELECT topic_id, label, top_terms, doc_count FROM topics ORDER BY topic_id").rows
    existing_labels = {int(row["topic_id"]): row["label"] for row in topic_rows}
    generation = load_topics_generation(client)
    overrides = load_topic_label_overrides(client, generation)
    selected_topic_ids = {
        int(row["topic_id"]) for row in topic_rows
        if int(row["topic_id"]) != -1 and (topic_id is None or int(row["topic_id"]) == int(topic_id))
    }
    info_rows = []
    topic_terms = {}
    for row in topic_rows:
        tid = int(row["topic_id"])
        if tid == -1 or tid in selected_topic_ids:
            terms = parse_top_terms(row["top_terms"])
            topic_terms[tid] = terms
            info_rows.append({
                "Topic": tid,
                "Name": f"{tid}_{'_'.join([term for term, _ in terms[:4]])}" if tid != -1 else "Uncategorized",
                "Count": int(row["doc_count"] or 0),
            })
    topic_info = ExistingTopicInfo(info_rows)
    topic_model = ExistingTopicModel(topic_terms, topic_info)

    rows = client.execute("""
        SELECT dt.topic_id, d.metadata_json
        FROM document_topics dt
        JOIN documents d ON d.doc_id = dt.doc_id
        WHERE dt.topic_id != -1
          AND COALESCE(json_extract(d.metadata_json, '$.accessStatus'), 'unknown')
                NOT IN ('embargoed', 'verification_due')
        ORDER BY dt.topic_id, dt.probability DESC
    """).rows
    abstracts = []
    assignments = []
    titles_by_topic = {}
    documents_by_topic = {}
    counts = {}
    for row in rows:
        tid = int(row["topic_id"])
        if tid not in selected_topic_ids:
            continue
        try:
            metadata = json.loads(row["metadata_json"] or "{}")
        except Exception:
            continue
        title = str(metadata.get("title") or "").strip()
        abstract = str(metadata.get("abstract") or metadata.get("description") or "").strip()
        if title:
            titles_by_topic.setdefault(tid, [])
            if title not in titles_by_topic[tid]:
                titles_by_topic[tid].append(title)
        if title or abstract:
            documents_by_topic.setdefault(tid, []).append({
                "title": title,
                "abstract": re.sub(r"\s+", " ", abstract).strip()[:420],
            })
        if counts.get(tid, 0) >= 3:
            continue
        if len(abstract) < 50:
            continue
        sample = f"Title: {title}\nAbstract: {abstract}" if title else abstract
        abstracts.append(sample)
        assignments.append(tid)
        counts[tid] = counts.get(tid, 0) + 1

    generated = generate_labels(topic_model, abstracts, assignments, reporter)
    backend = os.environ.get("LOCAL_LABEL_BACKEND", "transformers")
    model_name = os.environ.get("LOCAL_LABEL_MODEL", os.environ.get("LOCAL_LABEL_MODEL_PATH", "Qwen/Qwen2.5-0.5B-Instruct"))
    candidates = build_candidate_rows(topic_model, topic_info, generated, abstracts, assignments, existing_labels, titles_by_topic, documents_by_topic)
    save_topic_label_candidates(client, candidates, backend, model_name, {"labelsOnly": True, "topicId": topic_id}, generation)
    labels = choose_topic_labels(topic_model, topic_info, candidates, overrides, existing_labels)
    for tid, label in labels.items():
        if tid == -1:
            continue
        client.execute("UPDATE topics SET label = ? WHERE topic_id = ?", [label, tid])
    mark_auto_selected_candidates(client, candidates, labels, overrides)
    print(f"Regenerated labels for {len(selected_topic_ids)} topics.")


import threading
import time

def claim_job(client, job_id, execution_id=None):
    supplied_execution_id = execution_id
    execution_id = execution_id or str(uuid.uuid4())
    now_str = datetime.now(timezone.utc).isoformat()
    if supplied_execution_id:
        # Node's legacy in-process runner can claim the job before launching
        # this script.  Reuse precisely that lease, never another worker's.
        client.execute(
            "UPDATE admin_jobs SET claimed_at = COALESCE(claimed_at, ?), execution_id = ?, "
            "runner_state = 'running', heartbeat_at = ? "
            "WHERE id = ? AND status = 'running' AND finished_at IS NULL "
            "AND (claimed_at IS NULL OR execution_id = ?)",
            [now_str, execution_id, now_str, int(job_id), execution_id]
        )
    else:
        client.execute(
            "UPDATE admin_jobs SET claimed_at = ?, execution_id = ?, runner_state = 'running', heartbeat_at = ? "
            "WHERE id = ? AND status = 'running' AND finished_at IS NULL AND claimed_at IS NULL",
            [now_str, execution_id, now_str, int(job_id)]
        )
    result = client.execute("SELECT status, execution_id, finished_at FROM admin_jobs WHERE id = ?", [int(job_id)])
    row = result.rows[0] if result.rows else None
    if not row or row["status"] != "running" or row["finished_at"] or row["execution_id"] != execution_id:
        raise RuntimeError("Admin job could not be claimed by this topic worker execution")
    return execution_id


def finish_job(client, job_id, execution_id, status, error=None):
    now_str = datetime.now(timezone.utc).isoformat()
    client.execute(
        "UPDATE admin_jobs SET status = ?, runner_state = ?, error = ?, finished_at = ?, "
        "artifact_token_hash = NULL, execution_id = NULL "
        "WHERE id = ? AND execution_id = ? AND status = 'running' AND finished_at IS NULL",
        [status, status, error, now_str, int(job_id), execution_id]
    )

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--labels-only", action="store_true")
    parser.add_argument("--topic-id", type=int)
    args = parser.parse_args()

    db_path = os.environ.get("SQLITE_PATH", DB_PATH)
    db_path = os.path.abspath(db_path)

    # Turso URLs do not need to exist as local files
    if not os.environ.get("TURSO_DATABASE_URL") and not os.path.exists(db_path):
        print(f"Error: database not found at {db_path}", file=sys.stderr)
        sys.exit(1)

    client = get_db_client(db_path)
    
    # Claim job if running in worker mode
    job_id = os.environ.get("ADMIN_JOB_ID")
    db_logger = None
    reporter = None
    execution_id = None
    if job_id:
        print(f"Claiming and starting job ID {job_id}")
        execution_id = claim_job(client, job_id, os.environ.get("ADMIN_JOB_EXECUTION_ID"))
        db_logger = DatabaseLogger(client, job_id, sys.stdout, execution_id)
        sys.stdout = db_logger
        sys.stderr = db_logger
        reporter = ProgressReporter(client, job_id, execution_id)

    try:
        if args.labels_only:
            if reporter:
                reporter.report(
                    "generate_labels",
                    "Generating Labels",
                    status="running",
                    detail="Regenerating labels for existing topics..."
                )
            run_label_only(client, topic_id=args.topic_id, reporter=reporter)
            if reporter:
                reporter.report(
                    "generate_labels",
                    "Generating Labels",
                    status="completed",
                    detail="Regenerated labels for existing topics.",
                    next_task="Completed"
                )
            if job_id:
                finish_job(client, job_id, execution_id, "completed")
            return

        # Load abstracts
        if reporter:
            reporter.report(
                "load_abstracts",
                "Loading Abstracts",
                status="running",
                detail="Loading document abstracts from database..."
            )
        rows_res = client.execute("""
            SELECT doc_id, metadata_json FROM documents
            WHERE COALESCE(json_extract(metadata_json, '$.accessStatus'), 'unknown')
                    NOT IN ('embargoed', 'verification_due')
        """)
        print(f"Found {len(rows_res.rows)} documents in database")

        doc_ids = []
        abstracts = []
        for row in rows_res.rows:
            try:
                meta = json.loads(row["metadata_json"])
            except (json.JSONDecodeError, TypeError):
                continue
            abstract = meta.get("abstract") or meta.get("description") or ""
            abstract = abstract.strip()
            if not abstract or len(abstract) < 50:
                continue
            doc_ids.append(row["doc_id"])
            abstracts.append(abstract)

        print(f"Extracted {len(abstracts)} non-empty abstracts (skipped {len(rows_res.rows) - len(abstracts)})")
        if reporter:
            reporter.report(
                "load_abstracts",
                "Loading Abstracts",
                status="completed",
                detail=f"Extracted {len(abstracts)} abstracts.",
                next_task="Checking Cache"
            )

        if len(abstracts) < MIN_TOPIC_SIZE:
            raise ValueError("Not enough abstracts to cluster")

        # 1. Load stored embeddings
        if reporter:
            reporter.report(
                "check_cache",
                "Checking Cache",
                status="running",
                detail="Retrieving cached embeddings from database..."
            )
        print("Checking for stored embeddings in database...")
        embeddings_matrix = None
        filled_mask = None
        _dim = None
        try:
            embeddings_matrix, filled_mask, _dim = load_cached_embeddings(client, doc_ids)
            print(f"Found {int(filled_mask.sum())} cached embeddings in database.")
        except Exception as e:
            print(f"Could not load stored embeddings (table might not exist yet): {e}")

        if reporter:
            reporter.report(
                "check_cache",
                "Checking Cache",
                status="completed",
                detail=f"Retrieved {int(filled_mask.sum()) if filled_mask is not None else 0} cached embeddings.",
                next_task="Computing Embeddings"
            )

        # 2. Compute embeddings incrementally
        import numpy as np
        if filled_mask is None:
            filled_mask = np.zeros(len(doc_ids), dtype=bool)
        docs_to_encode_indices = [i for i in range(len(doc_ids)) if not filled_mask[i]]
        docs_to_encode = [abstracts[i] for i in docs_to_encode_indices]
        cached_new = 0
        batch_embeddings = None
        cache_rows = None

        if docs_to_encode:
            print(f"Loading embedding model to encode {len(docs_to_encode)} new documents: {MODEL_NAME}")
            if reporter:
                reporter.report(
                    "compute_embeddings",
                    "Computing Embeddings",
                    status="running",
                    detail=f"Loading model to encode {len(docs_to_encode)} new documents...",
                    counts={"processed": 0, "total": len(docs_to_encode)}
                )
            from sentence_transformers import SentenceTransformer
            embedding_model = SentenceTransformer(MODEL_NAME)
            
            # Encode incrementally in batches of 32 to report real-time progress
            batch_size = 32
            i = 0
            while i < len(docs_to_encode):
                batch = docs_to_encode[i:i+batch_size]
                if reporter:
                    reporter.report(
                        "compute_embeddings",
                        "Computing Embeddings",
                        status="running",
                        detail=f"Encoding new documents (batch {i//batch_size + 1}/{(len(docs_to_encode) + batch_size - 1) // batch_size})...",
                        counts={"processed": i, "total": len(docs_to_encode)}
                    )
                batch_embeddings = embedding_model.encode(batch, show_progress_bar=False)

                # The encoder's dimension can differ from the cached matrix (model changed,
                # or the cache mixes dimensions). Nothing from this batch is written yet, so
                # discard the cached matrix and re-encode every document at the new dimension.
                if embeddings_matrix is not None and batch_embeddings.shape[1] != embeddings_matrix.shape[1]:
                    print(f"Encoder dimension {batch_embeddings.shape[1]} != cached dimension "
                          f"{embeddings_matrix.shape[1]}; discarding cached embeddings and re-encoding all "
                          f"{len(doc_ids)} documents.")
                    embeddings_matrix = None
                    docs_to_encode_indices = list(range(len(doc_ids)))
                    docs_to_encode = list(abstracts)
                    i = 0
                    continue

                # Flush this batch to the cache now so progress survives a crash
                now_iso = datetime.now(timezone.utc).isoformat()
                cache_rows = []
                for j, new_emb in enumerate(batch_embeddings):
                    orig_idx = docs_to_encode_indices[i + j]
                    if embeddings_matrix is None:
                        embeddings_matrix = np.empty((len(doc_ids), len(new_emb)), dtype=np.float32)
                    embeddings_matrix[orig_idx] = new_emb
                    cache_rows.append([doc_ids[orig_idx], json.dumps(new_emb.tolist()), now_iso])
                try:
                    write_rows(
                        client,
                        "INSERT OR REPLACE INTO document_embeddings (doc_id, embedding, created_at) VALUES (?, ?, ?)",
                        cache_rows,
                    )
                    cached_new += len(cache_rows)
                except Exception as ex:
                    print(f"Failed to cache {len(cache_rows)} embeddings: {ex}")
                i += batch_size

            if cached_new == len(docs_to_encode):
                print(f"Successfully cached {cached_new} new embeddings.")
            else:
                print(f"Cached {cached_new} of {len(docs_to_encode)} new embeddings; the rest will be re-encoded next run.")
            
            # Explicitly free up SentenceTransformer to save memory
            del embedding_model
            import torch
            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
                
            if reporter:
                reporter.report(
                    "compute_embeddings",
                    "Computing Embeddings",
                    status="completed",
                    detail=f"Encoded {len(docs_to_encode)} documents; cached {cached_new}.",
                    counts={"processed": len(docs_to_encode), "total": len(docs_to_encode)},
                    next_task="Clustering Topics"
                )
        else:
            print("All documents are cached. Bypassing embedding model loading entirely!")
            if reporter:
                reporter.report(
                    "compute_embeddings",
                    "Computing Embeddings",
                    status="completed",
                    detail="All documents already cached; bypassed encoding phase.",
                    counts={"processed": 0, "total": 0},
                    next_task="Clustering Topics"
                )

        # The embedding matrix is complete; release the cache-loading intermediates
        del filled_mask, _dim, docs_to_encode, docs_to_encode_indices, batch_embeddings, cache_rows
        gc.collect()

        # Run BERTopic
        from bertopic import BERTopic
        from hdbscan import HDBSCAN
        from umap import UMAP

        vectorizer_model = build_topic_vectorizer()

        min_topic_size = resolve_min_topic_size(len(abstracts))
        nr_topics = resolve_max_topics()
        umap_kwargs, hdbscan_kwargs = cluster_model_params(min_topic_size)
        umap_model = UMAP(**umap_kwargs)
        hdbscan_model = HDBSCAN(**hdbscan_kwargs)

        if reporter:
            reporter.report(
                "cluster_topics",
                "Clustering Topics",
                status="running",
                detail=f"Fitting BERTopic model (UMAP & HDBSCAN, min_topic_size={min_topic_size}, nr_topics={nr_topics})..."
            )
        print(f"Fitting BERTopic (min_topic_size={min_topic_size}, nr_topics={nr_topics}, min_samples=1, "
              f"cluster_selection_epsilon={HDBSCAN_CLUSTER_SELECTION_EPSILON}, seed={TOPIC_RANDOM_STATE})...")
        bertopic_kwargs = {"nr_topics": nr_topics} if nr_topics is not None else {}
        topic_model = BERTopic(
            embedding_model=MODEL_NAME,
            min_topic_size=min_topic_size,
            umap_model=umap_model,
            hdbscan_model=hdbscan_model,
            vectorizer_model=vectorizer_model,
            verbose=True,
            **bertopic_kwargs,
        )
        topics, probs = topic_model.fit_transform(abstracts, embeddings=embeddings_matrix)

        # Reduce outliers — reassign topic -1 docs using c-TF-IDF similarity.
        # The "c-tf-idf" strategy only reassigns a doc if its text has strong
        # vocabulary overlap with a topic, preventing unrelated docs from being
        # forced into the nearest cluster by embedding distance alone.
        outlier_count = sum(1 for t in topics if t == -1)
        if outlier_count > 0:
            print(f"\nReducing outliers ({outlier_count} docs) using c-TF-IDF strategy...")
            topics = topic_model.reduce_outliers(abstracts, topics, strategy="c-tf-idf", threshold=0.15)
            refresh_topic_representation(topic_model, abstracts, topics, vectorizer_model)
            new_outliers = sum(1 for t in topics if t == -1)
            print(f"  Outliers reduced: {outlier_count} -> {new_outliers}")

        # Compute hierarchical topic structure from topic embeddings
        import numpy as np
        from sklearn.metrics.pairwise import cosine_similarity
        from scipy.cluster.hierarchy import linkage
        from scipy.spatial.distance import squareform

        print("\nComputing topic hierarchy (ward linkage on topic embeddings)...")
        all_topic_info = topic_model.get_topic_info()
        all_topic_ids = sorted(all_topic_info[all_topic_info["Topic"] != -1]["Topic"].tolist())
        embeddings_raw = topic_model.topic_embeddings_

        # BERTopic keeps an extra embedding row for the outlier topic (-1) even after
        # outlier reduction removes it from topic_info. Detect this by comparing the
        # embedding count to the number of non-outlier topics.
        if embeddings_raw.shape[0] == len(all_topic_ids) + 1:
            hierarchy_embeddings = embeddings_raw[1:]  # skip ghost outlier row
        else:
            hierarchy_embeddings = embeddings_raw

        if len(all_topic_ids) >= 2:
            dist_matrix = 1 - cosine_similarity(hierarchy_embeddings)
            np.fill_diagonal(dist_matrix, 0)
            condensed = squareform(dist_matrix, checks=False)
            linkage_matrix = linkage(condensed, method='ward', optimal_ordering=True)

            # Store in topic_hierarchy_meta table
            leaf_topic_ids_json = json.dumps(all_topic_ids)
            linkage_json = json.dumps(linkage_matrix.tolist())
            print(f"  Linkage matrix: {len(linkage_matrix)} merge steps for {len(all_topic_ids)} topics")
        else:
            leaf_topic_ids_json = None
            linkage_json = None
            print("  Skipping hierarchy — fewer than 2 topics")

        # Extract topic info
        topic_info = topic_model.get_topic_info()
        now = datetime.now(timezone.utc).isoformat()
        ensure_topic_label_tables(client)

        print(f"\nDiscovered {len(topic_info) - 1} topics (plus outlier cluster); "
              f"min_topic_size={min_topic_size}, nr_topics={nr_topics}")
        if reporter:
            reporter.report(
                "cluster_topics",
                "Clustering Topics",
                status="completed",
                detail=f"Discovered {len(topic_info) - 1} topics (min_topic_size={min_topic_size}, nr_topics={nr_topics}).",
                next_task="Generating Labels"
            )

        # Generate human-readable labels (Claude API or local Qwen model fallback)
        claude_labels = generate_labels(topic_model, abstracts, topics, reporter)
        label_candidates = build_candidate_rows(topic_model, topic_info, claude_labels, abstracts, topics)
        backend = "claude" if os.environ.get("ANTHROPIC_API_KEY", "").strip() else os.environ.get("LOCAL_LABEL_BACKEND", "transformers")
        label_model_name = CLAUDE_MODEL if backend == "claude" else os.environ.get("LOCAL_LABEL_MODEL", os.environ.get("LOCAL_LABEL_MODEL_PATH", "Qwen/Qwen2.5-0.5B-Instruct"))
        save_topic_label_candidates(
            client,
            label_candidates,
            backend,
            label_model_name,
            {"autoPublish": os.environ.get("TOPIC_LABEL_AUTO_PUBLISH", "passing_only")},
            # Same string publish_staged_topics stamps as the new topics_generation
            now,
        )
        topic_labels = choose_topic_labels(topic_model, topic_info, label_candidates)

        if reporter:
            reporter.report(
                "save_results",
                "Saving Results",
                status="running",
                detail="Writing topics and assignments to database..."
            )

        # Live tables must exist (for the swap); results go to staging tables first
        ensure_live_topic_tables(client)
        prepare_staging_topic_tables(client)

        # Write topic rows
        topic_rows = []
        for _, row in topic_info.iterrows():
            topic_id = int(row["Topic"])
            label = topic_labels.get(topic_id, bertopic_default_label(topic_model, topic_id, row))
            count = int(row.get("Count", 0))

            # Get top terms with weights
            topic_terms = topic_model.get_topic(topic_id)
            if topic_terms and isinstance(topic_terms, list):
                top_terms_json = json.dumps(topic_terms[:10])
            else:
                top_terms_json = "[]"

            topic_rows.append([topic_id, label, top_terms_json, count, MODEL_NAME, now])
        write_rows(
            client,
            "INSERT OR REPLACE INTO topics_next (topic_id, label, top_terms, doc_count, model_name, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            topic_rows,
        )
        mark_auto_selected_candidates(client, label_candidates, topic_labels)

        # Write document-topic assignments
        doc_topic_rows = []
        for i, (doc_id, topic_id) in enumerate(zip(doc_ids, topics)):
            prob = float(probs[i]) if probs is not None and len(probs) > i else None
            # probs can be a numpy array or list; handle both
            if hasattr(probs, "ndim") and probs.ndim == 2:
                # Multi-topic probability matrix — take the max
                prob = float(probs[i].max())
            doc_topic_rows.append([doc_id, int(topic_id), prob])
        write_rows(
            client,
            "INSERT OR REPLACE INTO document_topics_next (doc_id, topic_id, probability) VALUES (?, ?, ?)",
            doc_topic_rows,
        )

        # Save topic hierarchy linkage
        if leaf_topic_ids_json and linkage_json:
            client.execute(
                "INSERT OR REPLACE INTO topic_hierarchy_meta_next (id, leaf_topic_ids, linkage_json, created_at) VALUES (1, ?, ?, ?)",
                [leaf_topic_ids_json, linkage_json, now],
            )
            print(f"  Saved topic hierarchy ({len(all_topic_ids)} leaves, {len(linkage_matrix)} merges)")

        # Release what the 2-D UMAP fit and the rest of the run no longer need
        # (still needed: topic_model, topic_info, topic_labels, topics, doc_ids, abstracts, embeddings_matrix)
        probs = doc_topic_rows = topic_rows = label_candidates = claude_labels = None
        embeddings_raw = hierarchy_embeddings = None
        dist_matrix = condensed = linkage_matrix = linkage_json = None
        gc.collect()

        # Extract 2D UMAP projection for scatter plot visualization
        import umap

        print("\nComputing 2D UMAP projection for visualization...")
        embeddings = embeddings_matrix
        reducer = umap.UMAP(n_components=2, random_state=TOPIC_RANDOM_STATE, metric="cosine")
        coords_2d = reducer.fit_transform(embeddings)

        write_rows(
            client,
            "INSERT OR REPLACE INTO document_topic_coords_next (doc_id, umap_x, umap_y) VALUES (?, ?, ?)",
            [[doc_id, float(coords_2d[i, 0]), float(coords_2d[i, 1])] for i, doc_id in enumerate(doc_ids)],
        )
        print(f"  Saved 2D coordinates for {len(doc_ids)} documents")

        # Atomically replace live topic tables with the staged results
        try:
            publish_staged_topics(client, now)
        except Exception as swap_error:
            if not staging_swap_committed(client, now):
                raise
            print(f"  Swap reported an error ({swap_error}) but staging tables are gone; "
                  "the swap committed. Continuing as success.", file=sys.stderr)
        print("  Published topics, assignments, hierarchy and coordinates")
        if reporter:
            reporter.report(
                "save_results",
                "Saving Results",
                status="completed",
                detail=f"Saved assignments and 2D coordinates for {len(doc_ids)} documents."
            )

        # Print summary
        assigned = sum(1 for t in topics if t != -1)
        outliers = sum(1 for t in topics if t == -1)
        print(f"\nSummary:")
        print(f"  Total documents processed: {len(abstracts)}")
        print(f"  Topics discovered: {len(topic_info) - 1}")
        print(f"  Documents assigned to topics: {assigned}")
        print(f"  Outliers (topic -1): {outliers}")

        print(f"\nTop topics by document count:")
        for _, row in topic_info.head(11).iterrows():
            tid = int(row["Topic"])
            if tid == -1:
                continue
            display = topic_labels.get(tid, row.get("Name", "?"))
            print(f"  Topic {tid}: {display} ({row.get('Count', 0)} docs)")

        # Optionally save model
        model_dir = os.path.join(os.path.dirname(db_path), "topics", "model")
        try:
            os.makedirs(os.path.dirname(model_dir), exist_ok=True)
            topic_model.save(model_dir)
            print(f"\nModel saved to: {model_dir}")
        except Exception as e:
            print(f"\nWarning: could not save model: {e}", file=sys.stderr)

        # Mark job completed if in worker mode
        if job_id:
            print(f"\nCompleting job ID {job_id} in database")
            finish_job(client, job_id, execution_id, "completed")
            
    except Exception as e:
        print(f"\nError: {e}", file=sys.stderr)
        if not args.labels_only:
            drop_staging_topic_tables(client)
        if reporter:
            reporter.report(
                reporter.tasks[-1]["key"] if reporter.tasks else "run",
                reporter.tasks[-1]["label"] if reporter.tasks else "Run",
                status="failed",
                detail=str(e)
            )
        if job_id:
            finish_job(client, job_id, execution_id, "failed", str(e))
        if db_logger:
            db_logger.flush()
        client.close()
        sys.exit(1)

    if db_logger:
        db_logger.flush()
    client.close()
    print("Done.")


if __name__ == "__main__":
    main()
