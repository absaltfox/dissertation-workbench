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

import json
import sqlite3
import sys
from datetime import datetime, timezone

MODEL_NAME = "allenai/specter2_base"
CLAUDE_MODEL = "claude-haiku-4-5-20251001"
MIN_TOPIC_SIZE = 3  # small for ~400-doc corpus to find niche topics
DB_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "metrics.sqlite")


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
    
    def close(self):
        self.conn.close()


class DatabaseLogger:
    def __init__(self, client, job_id, original_stdout):
        self.client = client
        self.job_id = int(job_id)
        self.original_stdout = original_stdout
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
                "UPDATE admin_jobs SET log = COALESCE(log, '') || ? WHERE id = ?",
                [text_to_write, self.job_id]
            )
        except Exception as e:
            self.original_stdout.write(f"\n[Logger Error] Failed to write log to DB: {e}\n")
            
    def _flush_loop(self):
        while True:
            time.sleep(3)
            self._flush_to_db()


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


def generate_labels(topic_model, abstracts, topic_assignments):
    """Generate human-readable topic labels using Claude (if API key set) or a local Qwen model."""
    api_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if api_key:
        labels = generate_claude_labels(topic_model, abstracts, topic_assignments, api_key)
        if labels and len(labels) > 1:
            return labels
    return generate_local_labels(topic_model, abstracts, topic_assignments)


def generate_claude_labels(topic_model, abstracts, topic_assignments, api_key):
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

    prompt = (
        "You are labeling topics discovered by clustering ~418 Education doctoral dissertation abstracts "
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
    except Exception as e:
        print(f"\nWarning: Claude label generation failed: {e}", file=sys.stderr)
        return {}

    return labels


def generate_local_labels(topic_model, abstracts, topic_assignments):
    """Use a local tiny LLM (Qwen/Qwen2.5-0.5B-Instruct) to generate topic labels."""
    print("\nLoading local label generation model: Qwen/Qwen2.5-0.5B-Instruct...")
    try:
        from transformers import AutoTokenizer, AutoModelForCausalLM
        import torch
        
        model_name = "Qwen/Qwen2.5-0.5B-Instruct"
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

    print(f"Generating labels for {len(topic_info) - 1} topics locally...")
    
    for _, row in topic_info.iterrows():
        topic_id = int(row["Topic"])
        if topic_id == -1:
            continue

        # Get top terms
        terms = topic_model.get_topic(topic_id)
        if not terms:
            continue
        top_words = [t[0] for t in terms[:10]]

        # Get representative abstracts (up to 3, truncated)
        doc_indices = [i for i, t in enumerate(topic_assignments) if t == topic_id][:3]
        sample_abstracts = [abstracts[i][:250] for i in doc_indices]

        # Formulate prompt for Qwen
        prompt = (
            f"Keywords: {', '.join(top_words)}\n"
            f"Sample Abstracts:\n"
            + "\n".join(f"- {a}..." for a in sample_abstracts)
            + "\n\nBased on the keywords and abstracts, generate a short, clean, descriptive academic topic title (3-6 words) as a noun phrase (e.g. 'Indigenous Education Policy' or 'Reading Comprehension & Assessment').\n"
              "Respond with ONLY the title. No other text."
        )

        messages = [
            {"role": "system", "content": "You are a helpful assistant that labels academic research topics. Respond with ONLY the short title."},
            {"role": "user", "content": prompt}
        ]

        text = tokenizer.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=True
        )
        model_inputs = tokenizer([text], return_tensors="pt")

        generated_ids = model.generate(
            model_inputs.input_ids,
            max_new_tokens=15,
            pad_token_id=tokenizer.eos_token_id,
            do_sample=False
        )
        generated_ids = [
            output_ids[len(input_ids):] for input_ids, output_ids in zip(model_inputs.input_ids, generated_ids)
        ]

        response = tokenizer.batch_decode(generated_ids, skip_special_tokens=True)[0].strip()
        response = response.replace('"', '').replace("'", "").strip(" .")
        
        print(f"  Topic {topic_id} -> {response}")
        labels[topic_id] = response

    del model
    del tokenizer
    import gc
    gc.collect()
    
    return labels


import threading
import time

def main():
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
    if job_id:
        print(f"Claiming and starting job ID {job_id}")
        now_str = datetime.now(timezone.utc).isoformat()
        client.execute(
            "UPDATE admin_jobs SET status = 'running', claimed_at = ?, started_at = ?, runner_state = 'running' WHERE id = ?",
            [now_str, now_str, int(job_id)]
        )
        db_logger = DatabaseLogger(client, job_id, sys.stdout)
        sys.stdout = db_logger
        sys.stderr = db_logger

    try:
        # Load abstracts
        rows_res = client.execute("SELECT doc_id, metadata_json FROM documents")
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

        if len(abstracts) < MIN_TOPIC_SIZE:
            raise ValueError("Not enough abstracts to cluster")

        # 1. Load stored embeddings
        print("Checking for stored embeddings in database...")
        stored_embeddings = {}
        try:
            embeddings_res = client.execute("SELECT doc_id, embedding FROM document_embeddings")
            for row in embeddings_res.rows:
                stored_embeddings[row["doc_id"]] = json.loads(row["embedding"])
            print(f"Found {len(stored_embeddings)} cached embeddings in database.")
        except Exception as e:
            print(f"Could not load stored embeddings (table might not exist yet): {e}")

        # 2. Compute embeddings incrementally
        import numpy as np
        final_embeddings = []
        docs_to_encode = []
        docs_to_encode_indices = []

        for idx, (doc_id, abstract) in enumerate(zip(doc_ids, abstracts)):
            if doc_id in stored_embeddings:
                final_embeddings.append(np.array(stored_embeddings[doc_id], dtype=np.float32))
            else:
                docs_to_encode.append(abstract)
                docs_to_encode_indices.append(idx)
                final_embeddings.append(None) # placeholder

        if docs_to_encode:
            print(f"Loading embedding model to encode {len(docs_to_encode)} new documents: {MODEL_NAME}")
            from sentence_transformers import SentenceTransformer
            embedding_model = SentenceTransformer(MODEL_NAME)
            new_embeddings = embedding_model.encode(docs_to_encode, show_progress_bar=True)
            
            # Save new embeddings back to database and update placeholders
            for i, new_emb in enumerate(new_embeddings):
                orig_idx = docs_to_encode_indices[i]
                doc_id = doc_ids[orig_idx]
                emb_list = new_emb.tolist()
                final_embeddings[orig_idx] = new_emb
                
                try:
                    client.execute(
                        "INSERT OR REPLACE INTO document_embeddings (doc_id, embedding, created_at) VALUES (?, ?, ?)",
                        [doc_id, json.dumps(emb_list), datetime.now(timezone.utc).isoformat()]
                    )
                except Exception as ex:
                    print(f"Failed to cache embedding for {doc_id}: {ex}")
            print(f"Successfully cached {len(docs_to_encode)} new embeddings.")
            
            # Explicitly free up SentenceTransformer to save memory
            del embedding_model
            import gc
            import torch
            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        else:
            print("All documents are cached. Bypassing embedding model loading entirely!")

        # Convert final_embeddings list to a single numpy array
        embeddings_matrix = np.vstack(final_embeddings)

        # Run BERTopic
        from bertopic import BERTopic
        from hdbscan import HDBSCAN

        hdbscan_model = HDBSCAN(
            min_cluster_size=MIN_TOPIC_SIZE,
            min_samples=1,
            metric="euclidean",
            prediction_data=True,
        )

        print(f"Fitting BERTopic (min_topic_size={MIN_TOPIC_SIZE}, min_samples=1)...")
        topic_model = BERTopic(
            embedding_model=MODEL_NAME,
            min_topic_size=MIN_TOPIC_SIZE,
            hdbscan_model=hdbscan_model,
            verbose=True,
        )
        topics, probs = topic_model.fit_transform(abstracts, embeddings=embeddings_matrix)

        # Reduce outliers — reassign topic -1 docs using c-TF-IDF similarity.
        # The "c-tf-idf" strategy only reassigns a doc if its text has strong
        # vocabulary overlap with a topic, preventing unrelated docs from being
        # forced into the nearest cluster by embedding distance alone.
        outlier_count = sum(1 for t in topics if t == -1)
        if outlier_count > 0:
            print(f"\nReducing outliers ({outlier_count} docs) using c-TF-IDF strategy...")
            topics = topic_model.reduce_outliers(abstracts, topics, strategy="c-tf-idf", threshold=0.1)
            topic_model.update_topics(abstracts, topics=topics)
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

        print(f"\nDiscovered {len(topic_info) - 1} topics (plus outlier cluster)")

        # Generate human-readable labels (Claude API or local Qwen model fallback)
        claude_labels = generate_labels(topic_model, abstracts, topics)

        # Create tables
        client.execute("""
            CREATE TABLE IF NOT EXISTS topics (
                topic_id    INTEGER PRIMARY KEY,
                label       TEXT NOT NULL,
                top_terms   TEXT NOT NULL,
                doc_count   INTEGER NOT NULL,
                model_name  TEXT NOT NULL,
                created_at  TEXT NOT NULL
            )
        """)
        client.execute("""
            CREATE TABLE IF NOT EXISTS document_topics (
                doc_id      TEXT NOT NULL,
                topic_id    INTEGER NOT NULL,
                probability REAL,
                PRIMARY KEY (doc_id, topic_id)
            )
        """)
        client.execute("""
            CREATE TABLE IF NOT EXISTS topic_hierarchy_meta (
                id              INTEGER PRIMARY KEY DEFAULT 1,
                leaf_topic_ids  TEXT NOT NULL,
                linkage_json    TEXT NOT NULL,
                created_at      TEXT NOT NULL
            )
        """)

        # Clear existing data (idempotent)
        client.execute("DELETE FROM document_topics")
        client.execute("DELETE FROM topics")
        client.execute("DELETE FROM topic_hierarchy_meta")

        # Write topic rows
        for _, row in topic_info.iterrows():
            topic_id = int(row["Topic"])
            # Use Claude-generated label if available, otherwise fall back to BERTopic default
            label = claude_labels.get(topic_id, str(row.get("Name", f"Topic_{topic_id}")))
            count = int(row.get("Count", 0))

            # Get top terms with weights
            topic_terms = topic_model.get_topic(topic_id)
            if topic_terms and isinstance(topic_terms, list):
                top_terms_json = json.dumps(topic_terms[:10])
            else:
                top_terms_json = "[]"

            client.execute(
                "INSERT INTO topics (topic_id, label, top_terms, doc_count, model_name, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                [topic_id, label, top_terms_json, count, MODEL_NAME, now],
            )

        # Write document-topic assignments
        for i, (doc_id, topic_id) in enumerate(zip(doc_ids, topics)):
            prob = float(probs[i]) if probs is not None and len(probs) > i else None
            # probs can be a numpy array or list; handle both
            if hasattr(probs, "ndim") and probs.ndim == 2:
                # Multi-topic probability matrix — take the max
                prob = float(probs[i].max())
            client.execute(
                "INSERT INTO document_topics (doc_id, topic_id, probability) VALUES (?, ?, ?)",
                [doc_id, int(topic_id), prob],
            )

        # Save topic hierarchy linkage
        if leaf_topic_ids_json and linkage_json:
            client.execute(
                "INSERT INTO topic_hierarchy_meta (id, leaf_topic_ids, linkage_json, created_at) VALUES (1, ?, ?, ?)",
                [leaf_topic_ids_json, linkage_json, now],
            )
            print(f"  Saved topic hierarchy ({len(all_topic_ids)} leaves, {len(linkage_matrix)} merges)")

        # Extract 2D UMAP projection for scatter plot visualization
        import umap

        print("\nComputing 2D UMAP projection for visualization...")
        embeddings = embedding_model.encode(abstracts, show_progress_bar=True)
        reducer = umap.UMAP(n_components=2, random_state=42, metric="cosine")
        coords_2d = reducer.fit_transform(embeddings)

        client.execute("""
            CREATE TABLE IF NOT EXISTS document_topic_coords (
                doc_id  TEXT PRIMARY KEY,
                umap_x  REAL NOT NULL,
                umap_y  REAL NOT NULL
            )
        """)
        client.execute("DELETE FROM document_topic_coords")

        for i, doc_id in enumerate(doc_ids):
            client.execute(
                "INSERT INTO document_topic_coords (doc_id, umap_x, umap_y) VALUES (?, ?, ?)",
                [doc_id, float(coords_2d[i, 0]), float(coords_2d[i, 1])],
            )
        print(f"  Saved 2D coordinates for {len(doc_ids)} documents")

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
            display = claude_labels.get(tid, row.get("Name", "?"))
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
            now_str = datetime.now(timezone.utc).isoformat()
            client.execute(
                "UPDATE admin_jobs SET status = 'completed', runner_state = 'completed', finished_at = ? WHERE id = ?",
                [now_str, int(job_id)]
            )
            
    except Exception as e:
        print(f"\nError: {e}", file=sys.stderr)
        if job_id:
            now_str = datetime.now(timezone.utc).isoformat()
            client.execute(
                "UPDATE admin_jobs SET status = 'failed', runner_state = 'failed', error = ?, finished_at = ? WHERE id = ?",
                [str(e), now_str, int(job_id)]
            )
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



if __name__ == "__main__":
    main()
