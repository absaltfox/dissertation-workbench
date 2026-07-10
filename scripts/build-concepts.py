#!/usr/bin/env python3
"""PatternRank-style concept worker.

Runs as an admin worker job. It loads stored dissertation metadata, generates
cheap-gated noun-phrase candidates, ranks candidates with sentence-transformer
similarity against document context, and writes the existing concept artifact
shape back to the web app.
"""

import json
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
DB_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "metrics.sqlite")
DAILY_HOUR_LOCAL = 2
MAX_CANDIDATES_PER_DOC = int(os.environ.get("CONCEPT_MAX_CANDIDATES_PER_DOC", "160"))
TOP_CANDIDATES_PER_DOC = int(os.environ.get("CONCEPT_TOP_CANDIDATES_PER_DOC", "12"))
MIN_RANK_SCORE = float(os.environ.get("CONCEPT_PATTERNRANK_MIN_SCORE", "0.28"))

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
        (concepts_dir / "latest.json").write_text(json.dumps(artifact, indent=2), encoding="utf-8")
        status = {
            "status": "idle",
            "trigger": "script",
            "lastRunAt": artifact["generatedAt"],
            "lastSuccessAt": artifact["generatedAt"],
            "message": f"PatternRank concept rebuild completed ({artifact['stats']['concepts']} concepts).",
            "stats": artifact["stats"],
        }
        (concepts_dir / "status.json").write_text(json.dumps(status, indent=2), encoding="utf-8")
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


def main():
    db_path = os.path.abspath(os.environ.get("SQLITE_PATH", DB_PATH))
    if not os.environ.get("TURSO_DATABASE_URL") and not os.path.exists(db_path):
        print(f"Error: database not found at {db_path}", file=sys.stderr)
        sys.exit(1)

    client = get_db_client(db_path)
    job_id = os.environ.get("ADMIN_JOB_ID")
    claim_job(client, job_id)
    reporter = JobReporter(client, job_id)

    try:
        reporter.append_log("Starting PatternRank concept rebuild.\n")
        reporter.report("load_documents", "Loading Documents", detail="Loading stored dissertation metadata...")
        rows = client.execute("SELECT doc_id, metadata_json FROM documents").rows
        docs = []
        failures = 0
        for row in rows:
            try:
                meta = json.loads(row["metadata_json"])
                text = document_text(meta)
                if not text:
                    continue
                docs.append({"id": row["doc_id"], "meta": meta, "text": text})
            except Exception:
                failures += 1
        reporter.report(
            "load_documents",
            "Loading Documents",
            status="completed",
            detail=f"Loaded {len(docs)} documents.",
            counts={"processed": len(docs), "total": len(rows), "failed": failures},
            next_task="Generating Candidates",
        )
        if not docs:
            raise ValueError("No stored documents are available for concept extraction.")

        phrase_docs = {}
        doc_candidates = []
        generated = 0
        rejected_gate = 0
        for idx, doc in enumerate(docs):
            candidates = extract_candidates(doc["meta"])
            generated += len(candidates)
            doc_candidates.append(candidates)
            for phrase in candidates:
                phrase_docs.setdefault(phrase, set()).add(idx)
            if idx % 50 == 0:
                reporter.report(
                    "candidate_generation",
                    "Generating Candidates",
                    detail=f"Processed {idx + 1} of {len(docs)} documents.",
                    counts={"processed": idx + 1, "total": len(docs), "candidates": generated, "rejected": rejected_gate, "failed": failures},
                )
        reporter.report(
            "candidate_generation",
            "Generating Candidates",
            status="completed",
            detail=f"Generated {generated} cheap-gated candidates.",
            counts={"processed": len(docs), "total": len(docs), "candidates": generated, "rejected": rejected_gate, "failed": failures},
            next_task="Computing Embeddings",
        )

        reporter.append_log(f"Loading sentence-transformer model: {MODEL_NAME}\n")
        from sentence_transformers import SentenceTransformer
        model = SentenceTransformer(MODEL_NAME)

        reporter.report(
            "embedding",
            "Computing Embeddings",
            detail=f"Encoding {len(docs)} documents and {len(phrase_docs)} candidate phrases.",
            counts={"processed": 0, "total": len(docs) + len(phrase_docs)},
        )
        doc_embeddings = model.encode([doc["text"] for doc in docs], show_progress_bar=False, batch_size=16)
        phrases = sorted(phrase_docs.keys())
        phrase_embeddings = model.encode(phrases, show_progress_bar=False, batch_size=64)
        phrase_embedding_map = {phrase: phrase_embeddings[i] for i, phrase in enumerate(phrases)}
        reporter.report(
            "embedding",
            "Computing Embeddings",
            status="completed",
            detail="Embeddings computed.",
            counts={"processed": len(docs) + len(phrases), "total": len(docs) + len(phrases)},
            next_task="Ranking Candidates",
        )

        accepted_by_doc = [set() for _ in docs]
        phrase_scores = {}
        rejected_rank = 0
        for idx, candidates in enumerate(doc_candidates):
            ranked = []
            for phrase in candidates:
                score = cosine(doc_embeddings[idx], phrase_embedding_map[phrase])
                ranked.append((score, phrase))
            ranked.sort(reverse=True)
            for score, phrase in ranked[:TOP_CANDIDATES_PER_DOC]:
                if score >= MIN_RANK_SCORE:
                    accepted_by_doc[idx].add(phrase)
                    phrase_scores[phrase] = max(phrase_scores.get(phrase, 0), score)
                else:
                    rejected_rank += 1
            if idx % 50 == 0:
                reporter.report(
                    "ranking",
                    "Ranking Candidates",
                    detail=f"Ranked candidates for {idx + 1} of {len(docs)} documents.",
                    counts={"processed": idx + 1, "total": len(docs), "accepted": sum(len(s) for s in accepted_by_doc), "rejected": rejected_rank, "failed": failures},
                )

        accepted_docs = {}
        for idx, phrases_for_doc in enumerate(accepted_by_doc):
            for phrase in phrases_for_doc:
                accepted_docs.setdefault(phrase, set()).add(idx)

        concepts = []
        total_docs = len(docs)
        for phrase, ids in accepted_docs.items():
            doc_freq = len(ids)
            if doc_freq < 1:
                continue
            concepts.append({
                "canonical": phrase,
                "variants": [],
                "docFreq": doc_freq,
                "idf": math.log((total_docs + 1) / (doc_freq + 1)),
                "patternRankScore": round(float(phrase_scores.get(phrase, 0)), 4),
                "source": "patternrank",
            })
        concepts.sort(key=lambda c: (-c["docFreq"], -c["patternRankScore"], c["canonical"]))
        variant_to_canonical = {}
        generated_at = datetime.now(timezone.utc).isoformat()
        artifact = {
            "version": 2,
            "generatedAt": generated_at,
            "source": {
                "documents": total_docs,
                "dailyHourLocal": DAILY_HOUR_LOCAL,
                "method": "patternrank",
                "model": MODEL_NAME,
            },
            "stats": {
                "candidatePhrases": len(phrase_docs),
                "qualityFilteredPhrases": len(accepted_docs),
                "concepts": len(concepts),
                "singleDocConcepts": sum(1 for c in concepts if c["docFreq"] == 1),
                "aliases": len(variant_to_canonical),
                "patternRankRejected": rejected_rank,
                "documents": total_docs,
                "failed": failures,
            },
            "concepts": concepts,
            "variantToCanonical": variant_to_canonical,
        }

        reporter.report(
            "write_results",
            "Writing Results",
            detail="Uploading concept artifact to web app.",
            counts={"processed": total_docs, "total": total_docs, "concepts": len(concepts), "failed": failures},
        )
        upload_concept_artifact(artifact)
        result = {
            "documents": total_docs,
            "candidates": len(phrase_docs),
            "accepted": len(accepted_docs),
            "rejected": rejected_rank,
            "concepts": len(concepts),
            "aliases": len(variant_to_canonical),
            "failed": failures,
            "method": "patternrank",
            "model": MODEL_NAME,
        }
        reporter.report(
            "complete",
            "Complete",
            status="completed",
            detail=f"PatternRank concept rebuild completed with {len(concepts)} concepts.",
            counts=result,
        )
        reporter.append_log(
            f"PatternRank concept rebuild completed: {len(concepts)} concepts, {len(phrase_docs)} candidates, {rejected_rank} rejected by rank, {failures} failed.\n"
        )
        reporter.finish("completed", result=result)
    except Exception as exc:
        message = str(exc)
        reporter.append_log(f"PatternRank concept rebuild failed: {message}\n")
        reporter.report("failed", "Failed", status="failed", detail=message)
        reporter.finish("failed", error=message)
        client.close()
        sys.exit(1)

    client.close()


if __name__ == "__main__":
    main()
