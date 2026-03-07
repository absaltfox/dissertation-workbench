#!/usr/bin/env python3
"""BERTopic sidecar: discover latent topics from dissertation abstracts.

Reads abstracts from the SQLite database, runs BERTopic clustering, and writes
topic assignments back to the `topics` and `document_topics` tables.

Usage:
    pip install -r requirements.txt
    python scripts/build-topics.py
"""

import json
import os
import sqlite3
import sys
from datetime import datetime, timezone

MODEL_NAME = "allenai/specter2_base"
CLAUDE_MODEL = "claude-haiku-4-5-20251001"
MIN_TOPIC_SIZE = 3  # small for ~400-doc corpus to find niche topics
DB_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "metrics.sqlite")


def generate_claude_labels(topic_model, abstracts, topic_assignments):
    """Use Claude to generate human-readable topic labels."""
    api_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not api_key:
        print("\nNo ANTHROPIC_API_KEY set — skipping Claude label generation, using default BERTopic labels")
        return {}

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
        print("  Falling back to default BERTopic labels")

    return labels


def main():
    db_path = os.environ.get("SQLITE_PATH", DB_PATH)
    db_path = os.path.abspath(db_path)

    if not os.path.exists(db_path):
        print(f"Error: database not found at {db_path}", file=sys.stderr)
        sys.exit(1)

    print(f"Opening database: {db_path}")
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row

    # Load abstracts
    rows = conn.execute("SELECT doc_id, metadata_json FROM documents").fetchall()
    print(f"Found {len(rows)} documents in database")

    doc_ids = []
    abstracts = []
    for row in rows:
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

    print(f"Extracted {len(abstracts)} non-empty abstracts (skipped {len(rows) - len(abstracts)})")

    if len(abstracts) < MIN_TOPIC_SIZE:
        print("Error: not enough abstracts to cluster", file=sys.stderr)
        sys.exit(1)

    # Run BERTopic
    print(f"Loading embedding model: {MODEL_NAME}")
    from sentence_transformers import SentenceTransformer
    from bertopic import BERTopic

    embedding_model = SentenceTransformer(MODEL_NAME)

    from hdbscan import HDBSCAN

    # min_samples=1 makes HDBSCAN more aggressive at assigning points to clusters
    # instead of dumping them into a single catch-all topic.
    hdbscan_model = HDBSCAN(
        min_cluster_size=MIN_TOPIC_SIZE,
        min_samples=1,
        metric="euclidean",
        prediction_data=True,
    )

    print(f"Fitting BERTopic (min_topic_size={MIN_TOPIC_SIZE}, min_samples=1)...")
    topic_model = BERTopic(
        embedding_model=embedding_model,
        min_topic_size=MIN_TOPIC_SIZE,
        hdbscan_model=hdbscan_model,
        verbose=True,
    )
    topics, probs = topic_model.fit_transform(abstracts)

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

    # Generate human-readable labels via Claude API
    claude_labels = generate_claude_labels(topic_model, abstracts, topics)

    # Create tables
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS topics (
            topic_id    INTEGER PRIMARY KEY,
            label       TEXT NOT NULL,
            top_terms   TEXT NOT NULL,
            doc_count   INTEGER NOT NULL,
            model_name  TEXT NOT NULL,
            created_at  TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS document_topics (
            doc_id      TEXT NOT NULL,
            topic_id    INTEGER NOT NULL,
            probability REAL,
            PRIMARY KEY (doc_id, topic_id)
        );
    """)

    conn.execute("""
        CREATE TABLE IF NOT EXISTS topic_hierarchy_meta (
            id              INTEGER PRIMARY KEY DEFAULT 1,
            leaf_topic_ids  TEXT NOT NULL,
            linkage_json    TEXT NOT NULL,
            created_at      TEXT NOT NULL
        )
    """)

    # Clear existing data (idempotent)
    conn.execute("DELETE FROM document_topics")
    conn.execute("DELETE FROM topics")
    conn.execute("DELETE FROM topic_hierarchy_meta")

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

        conn.execute(
            "INSERT INTO topics (topic_id, label, top_terms, doc_count, model_name, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (topic_id, label, top_terms_json, count, MODEL_NAME, now),
        )

    # Write document-topic assignments
    for i, (doc_id, topic_id) in enumerate(zip(doc_ids, topics)):
        prob = float(probs[i]) if probs is not None and len(probs) > i else None
        # probs can be a numpy array or list; handle both
        if hasattr(probs, "ndim") and probs.ndim == 2:
            # Multi-topic probability matrix — take the max
            prob = float(probs[i].max())
        conn.execute(
            "INSERT INTO document_topics (doc_id, topic_id, probability) VALUES (?, ?, ?)",
            (doc_id, int(topic_id), prob),
        )

    # Save topic hierarchy linkage
    if leaf_topic_ids_json and linkage_json:
        conn.execute(
            "INSERT INTO topic_hierarchy_meta (id, leaf_topic_ids, linkage_json, created_at) VALUES (1, ?, ?, ?)",
            (leaf_topic_ids_json, linkage_json, now),
        )
        print(f"  Saved topic hierarchy ({len(all_topic_ids)} leaves, {len(linkage_matrix)} merges)")

    conn.commit()

    # Extract 2D UMAP projection for scatter plot visualization
    import umap

    print("\nComputing 2D UMAP projection for visualization...")
    embeddings = embedding_model.encode(abstracts, show_progress_bar=True)
    reducer = umap.UMAP(n_components=2, random_state=42, metric="cosine")
    coords_2d = reducer.fit_transform(embeddings)

    conn.execute("""
        CREATE TABLE IF NOT EXISTS document_topic_coords (
            doc_id  TEXT PRIMARY KEY,
            umap_x  REAL NOT NULL,
            umap_y  REAL NOT NULL
        )
    """)
    conn.execute("DELETE FROM document_topic_coords")

    for i, doc_id in enumerate(doc_ids):
        conn.execute(
            "INSERT INTO document_topic_coords (doc_id, umap_x, umap_y) VALUES (?, ?, ?)",
            (doc_id, float(coords_2d[i, 0]), float(coords_2d[i, 1])),
        )
    conn.commit()
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

    conn.close()
    print("Done.")


if __name__ == "__main__":
    main()
