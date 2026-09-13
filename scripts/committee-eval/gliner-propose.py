#!/usr/bin/env python3
"""GLiNER shadow-proposer: emit person-name spans (with GLOBAL char offsets) for
each gold doc, restricted to bounded windows around gratitude/role cues.

Proposals ONLY — no roles, no decisions. The deterministic cue layer
(score-shadow.mjs) owns role assignment and validates each span by an evidence
window. GLiNER's own labels are deliberately ignored (the probe showed they
over-attribute).

Run in the pinned venv:
  <scratchpad>/gliner-venv/bin/python scripts/committee-eval/gliner-propose.py

Reads:  data/committee-eval/fulltext/<docId>.txt  (per gold doc)
Writes: data/committee-eval/results-gliner-raw.json
        [{docId, spans:[{text, start, end, score}]}]
"""
import json
import os
import re
import sys
import time

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GOLD = os.path.join(REPO, "test/fixtures/committee-eval/gold.json")
TEXT_DIR = os.path.join(REPO, "data/committee-eval/fulltext")
OUT = os.path.join(REPO, "data/committee-eval/results-gliner-raw.json")

MODEL_NAME = "urchade/gliner_small-v2.1"
LABELS = ["person"]
THRESHOLD = 0.3

# Cue vocabulary that anchors a candidate window. Matches gratitude and role cues;
# the deterministic layer decides role/validity — this only bounds where GLiNER looks.
CUE_RE = re.compile(r"acknowledg|thank|grateful|indebted|supervisor|advis(or|er)|committee", re.IGNORECASE)

# Window geometry: names can precede ("Joy Dixon, my advisor") or follow
# ("my advisor, Joy Dixon") the cue, so we extend on both sides for ~600 chars.
WIN_BEFORE = 200
WIN_AFTER = 400


def merge_windows(spans):
    """Merge overlapping/adjacent (start,end) windows to minimize GLiNER runs."""
    if not spans:
        return []
    spans = sorted(spans)
    merged = [list(spans[0])]
    for s, e in spans[1:]:
        if s <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e])
    return merged


def main():
    t0 = time.time()
    print(f"loading {MODEL_NAME} ...", flush=True)
    from gliner import GLiNER
    model = GLiNER.from_pretrained(MODEL_NAME)
    print(f"loaded ({time.time() - t0:.0f}s)", flush=True)

    gold = json.load(open(GOLD))
    out = []
    n_docs = 0
    n_windows = 0
    n_spans = 0
    for i, g in enumerate(gold):
        doc_id = g["docId"]
        text_path = os.path.join(TEXT_DIR, f"{doc_id}.txt")
        if not os.path.exists(text_path):
            print(f"[{i+1}/{len(gold)}] {doc_id} SKIP (no cached text)", flush=True)
            continue
        text = open(text_path, encoding="utf-8").read()

        raw_windows = []
        for m in CUE_RE.finditer(text):
            ws = max(0, m.start() - WIN_BEFORE)
            we = min(len(text), m.start() + WIN_AFTER)
            raw_windows.append((ws, we))
        windows = merge_windows(raw_windows)

        seen = set()  # (global_start, global_end)
        spans = []
        for (ws, we) in windows:
            chunk = text[ws:we]
            if not chunk.strip():
                continue
            for e in model.predict_entities(chunk, LABELS, threshold=THRESHOLD):
                gs = ws + e["start"]
                ge = ws + e["end"]
                key = (gs, ge)
                if key in seen:
                    continue
                seen.add(key)
                spans.append({
                    "text": e["text"],
                    "start": gs,
                    "end": ge,
                    "score": round(float(e["score"]), 4),
                })
        spans.sort(key=lambda s: (s["start"], s["end"]))
        out.append({"docId": doc_id, "spans": spans})
        n_docs += 1
        n_windows += len(windows)
        n_spans += len(spans)
        print(f"[{i+1}/{len(gold)}] {doc_id}: {len(windows)} windows -> {len(spans)} spans "
              f"({time.time() - t0:.0f}s)", flush=True)

    json.dump(out, open(OUT, "w"), indent=2)
    print(f"\nWROTE {OUT}", flush=True)
    print(f"docs={n_docs} windows={n_windows} spans={n_spans} elapsed={time.time()-t0:.0f}s", flush=True)


if __name__ == "__main__":
    main()
