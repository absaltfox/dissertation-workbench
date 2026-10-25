#!/usr/bin/env python3
"""Synthetic scale harness for scripts/build-topics.py (issue #57).

Seeds a TEMP database (never data/) with N fake documents carrying abstracts and
random 768-d JSON embeddings, plus pre-existing "old" topics, then either:

  --io-only (default)  exercises the DB-I/O paths of build-topics.py end to end
                       without any ML deps: paged embedding load -> batched writes
                       into staging tables -> atomic publish.
  --full               runs scripts/build-topics.py as a subprocess against the
                       temp DB (needs the BERTopic stack; SQLITE_PATH is pointed
                       at the temp DB).

A separate reader process polls `SELECT COUNT(*) FROM topics` the whole time and
counts empty reads (there must be none, since old topics were pre-seeded).
--inject-failure first raises mid-write (before the swap) and asserts the live
topic tables are unchanged.

Remote safety: the seeding step DROPs and recreates `documents`,
`document_embeddings`, the topic tables and their staging tables. If
TURSO_DATABASE_URL is set the harness refuses to run (exit 2) unless
`--allow-remote <host>` exactly equals that URL's hostname, and it additionally
refuses if the remote `documents` table exists and has any rows (only empty
scratch databases are allowed). Remote readers poll every 50 ms.

The last stdout line is a single JSON summary.
"""
import argparse
import hashlib
import importlib.util
import json
import multiprocessing as mp
import os
import resource
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
DIM = 768
N_TOPICS = 40
OLD_TOPICS = 5


def load_build_topics():
    sys.modules.setdefault("torch", None)  # importing torch hangs in this venv; not needed here
    spec = importlib.util.spec_from_file_location("build_topics", os.path.join(HERE, "build-topics.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def peak_rss_mb(who=resource.RUSAGE_SELF):
    rss = resource.getrusage(who).ru_maxrss
    # macOS reports bytes, Linux reports kilobytes
    return round(rss / (1024 * 1024) if sys.platform == "darwin" else rss / 1024, 1)


def reader_main(db_path, stop, out, interval=0.001):
    """Poll COUNT(*) FROM topics until stop is set; report reads and empty reads."""
    bt = load_build_topics()
    client = bt.get_db_client(db_path)
    reads = empty = errors = 0
    while not stop.is_set():
        try:
            n = client.execute("SELECT COUNT(*) FROM topics").rows[0][0]
            reads += 1
            if n == 0:
                empty += 1
        except Exception:
            errors += 1  # transient lock/network errors are not empty reads
        time.sleep(interval)
    out.put({"reads": reads, "empty_reads": empty, "read_errors": errors})


def seed(bt, client, n_docs):
    import numpy as np

    rng = np.random.default_rng(42)
    for table in ("documents", "document_embeddings"):
        client.execute(f"DROP TABLE IF EXISTS {table}")
    for name in bt.TOPIC_TABLE_SCHEMAS:
        client.execute(f"DROP TABLE IF EXISTS {name}")
        client.execute(f"DROP TABLE IF EXISTS {name}_next")
    client.execute("CREATE TABLE documents (doc_id TEXT PRIMARY KEY, metadata_json TEXT NOT NULL)")
    client.execute(
        "CREATE TABLE document_embeddings (doc_id TEXT PRIMARY KEY, embedding TEXT, created_at TEXT)"
    )
    bt.ensure_live_topic_tables(client)

    chunk = 500
    for start in range(0, n_docs, chunk):
        ids = [f"doc{i:06d}" for i in range(start, min(start + chunk, n_docs))]
        docs = [[i, json.dumps({
            "abstract": f"Synthetic abstract {i} about education research topic {int(i[3:]) % N_TOPICS}. " * 3,
            "accessStatus": "open",
        })] for i in ids]
        vecs = rng.standard_normal((len(ids), DIM)).astype("float32").round(4)
        embs = [[i, json.dumps(v.tolist()), "seed"] for i, v in zip(ids, vecs)]
        bt.write_rows(client, "INSERT INTO documents (doc_id, metadata_json) VALUES (?, ?)", docs)
        bt.write_rows(client, "INSERT INTO document_embeddings (doc_id, embedding, created_at) VALUES (?, ?, ?)", embs)

    # Old live topics so the "never empty" check is meaningful
    bt.write_rows(
        client,
        "INSERT INTO topics (topic_id, label, top_terms, doc_count, model_name, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        [[i, f"Old topic {i}", "[]", 10, "old-model", "2020-01-01"] for i in range(OLD_TOPICS)],
    )
    bt.write_rows(
        client,
        "INSERT INTO document_topics (doc_id, topic_id, probability) VALUES (?, ?, ?)",
        [[f"doc{i:06d}", i % OLD_TOPICS, 0.5] for i in range(min(n_docs, 100))],
    )


def live_fingerprint(client):
    """Hash of every live topic table's contents, to detect any change."""
    h = hashlib.sha256()
    for name in ("topics", "document_topics", "topic_hierarchy_meta", "document_topic_coords"):
        rows = client.execute(f"SELECT * FROM {name} ORDER BY 1, 2").rows if name != "topic_hierarchy_meta" \
            else client.execute(f"SELECT * FROM {name} ORDER BY 1").rows
        h.update(name.encode())
        for r in rows:
            h.update(repr(tuple(r)).encode())
    return h.hexdigest()


class BatchCounter:
    """Wrap a client to count batch() calls and optionally fail from the Nth call on."""

    def __init__(self, client, fail_from=None):
        self._client = client
        self.batches = 0
        self.fail_from = fail_from

    def batch(self, statements):
        self.batches += 1
        if self.fail_from is not None and self.batches >= self.fail_from:
            raise RuntimeError("injected failure")
        return self._client.batch(statements)

    def __getattr__(self, name):
        return getattr(self._client, name)


def staged_write(bt, client, doc_ids, now):
    """Write synthetic results into staging (the same writes build-topics.py makes)."""
    bt.prepare_staging_topic_tables(client)
    bt.write_rows(
        client,
        "INSERT OR REPLACE INTO topics_next (topic_id, label, top_terms, doc_count, model_name, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        [[t, f"New topic {t}", "[]", len(doc_ids) // N_TOPICS, "bench", now] for t in range(N_TOPICS)],
    )
    bt.write_rows(
        client,
        "INSERT OR REPLACE INTO document_topics_next (doc_id, topic_id, probability) VALUES (?, ?, ?)",
        [[d, i % N_TOPICS, 0.9] for i, d in enumerate(doc_ids)],
    )
    client.execute(
        "INSERT OR REPLACE INTO topic_hierarchy_meta_next (id, leaf_topic_ids, linkage_json, created_at) VALUES (1, ?, ?, ?)",
        ["[]", "[]", now],
    )
    bt.write_rows(
        client,
        "INSERT OR REPLACE INTO document_topic_coords_next (doc_id, umap_x, umap_y) VALUES (?, ?, ?)",
        [[d, float(i % 97), float(i % 89)] for i, d in enumerate(doc_ids)],
    )


def check_injected_failure(bt, client, doc_ids):
    """Fail mid-write before the swap; live topics must be unchanged."""
    before = live_fingerprint(client)
    wrapped = BatchCounter(client, fail_from=2)
    orig_sleep = bt.time.sleep
    bt.time.sleep = lambda s: None  # skip retry backoff in the harness
    raised = False
    try:
        staged_write(bt, wrapped, doc_ids, "now")
    except RuntimeError:
        raised = True
    finally:
        bt.time.sleep = orig_sleep
        bt.drop_staging_topic_tables(client)
    return raised and live_fingerprint(client) == before


def run_io(bt, client, doc_ids):
    counted = BatchCounter(client)
    matrix, filled, dim = bt.load_cached_embeddings(counted, doc_ids)
    assert matrix is not None and dim == DIM and bool(filled.all()), "embedding load incomplete"
    rows = int(filled.sum())
    del matrix
    now = time.strftime("%Y-%m-%dT%H:%M:%S")
    staged_write(bt, counted, doc_ids, now)
    bt.publish_staged_topics(counted, now)
    live = client.execute("SELECT COUNT(*) FROM topics").rows[0][0]
    dt = client.execute("SELECT COUNT(*) FROM document_topics").rows[0][0]
    assert live == N_TOPICS and dt == len(doc_ids), f"unexpected live counts topics={live} document_topics={dt}"
    return counted.batches, rows + live + dt


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("-n", "--docs", type=int, default=14000)
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--io-only", action="store_true", help="DB-I/O paths only (default)")
    mode.add_argument("--full", action="store_true", help="run build-topics.py as a subprocess")
    ap.add_argument("--inject-failure", action="store_true", help="assert a mid-write failure leaves live topics unchanged")
    ap.add_argument("--allow-remote", metavar="HOST", default=None,
                    help="permit DROP/seed against TURSO_DATABASE_URL; must equal its hostname, and the remote "
                         "`documents` table must be empty or absent")
    args = ap.parse_args()

    remote = os.environ.get("TURSO_DATABASE_URL", "").strip()
    if remote:
        host = urlparse(remote).hostname or ""
        if not host or args.allow_remote != host:
            print(f"Refusing to DROP/seed tables on TURSO_DATABASE_URL: pass --allow-remote {host or '<host>'} "
                  "(must exactly match the database hostname).", file=sys.stderr)
            return 2

    bt = load_build_topics()
    tmp = tempfile.mkdtemp(prefix="bench-topics-")
    db_path = os.path.join(tmp, "bench.sqlite")
    client = bt.get_db_client(db_path)
    if remote:
        try:
            existing = client.execute("SELECT COUNT(*) FROM documents").rows[0][0]
        except Exception:
            existing = 0  # no documents table: nothing to destroy
        if existing:
            print(f"Refusing: remote `documents` table already has {existing} rows; "
                  "only empty scratch databases are allowed.", file=sys.stderr)
            return 2
    if not remote:
        client.execute("PRAGMA journal_mode=WAL")  # temp DB only: readers are not blocked by the writer
    t0 = time.time()
    seed(bt, client, args.docs)
    seed_s = round(time.time() - t0, 2)
    doc_ids = [f"doc{i:06d}" for i in range(args.docs)]

    injected_ok = check_injected_failure(bt, client, doc_ids) if args.inject_failure else None

    ctx = mp.get_context("spawn")
    stop, out = ctx.Event(), ctx.Queue()
    reader = ctx.Process(target=reader_main, args=(db_path, stop, out, 0.05 if remote else 0.001))
    reader.start()

    t0 = time.time()
    batches = rows = None
    child_rss = None
    if args.full:
        env = dict(os.environ, SQLITE_PATH=db_path)
        r = subprocess.run([sys.executable, os.path.join(HERE, "build-topics.py")], env=env)
        if r.returncode != 0:
            stop.set(); reader.join()
            print(f"build-topics.py exited {r.returncode}", file=sys.stderr)
            return r.returncode
        child_rss = peak_rss_mb(resource.RUSAGE_CHILDREN)
    else:
        batches, rows = run_io(bt, client, doc_ids)
    wall = round(time.time() - t0, 2)

    stop.set()
    stats = out.get(timeout=30)
    reader.join(timeout=30)

    summary = {
        "mode": "full" if args.full else "io-only",
        "docs": args.docs,
        "seed_s": seed_s,
        "wall_s": wall,
        "batches": batches,
        "rows": rows,
        "peak_rss_mb": child_rss if args.full else peak_rss_mb(),
        "reads": stats["reads"],
        "empty_reads": stats["empty_reads"],
        "read_errors": stats["read_errors"],
        "injected_failure_ok": injected_ok,
    }
    print(json.dumps(summary))
    ok = stats["empty_reads"] == 0 and stats["reads"] > 0 and injected_ok in (None, True)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
