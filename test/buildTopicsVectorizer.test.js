import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function runPythonSnippet(source) {
  const output = execFileSync('python3', ['-c', source], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  return JSON.parse(output);
}

test('refresh_topic_representation passes the stop-word vectorizer to update_topics', () => {
  const result = runPythonSnippet(`
import importlib.util, json
spec = importlib.util.spec_from_file_location("bt", "scripts/build-topics.py")
bt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bt)

class FakeTopicModel:
  def __init__(self):
    self.calls = []
  def update_topics(self, docs, **kwargs):
    self.calls.append({"docs": docs, "kwargs": kwargs})

model = FakeTopicModel()
vec = object()
docs = ["abstract one", "abstract two"]
topics = [0, 1]
bt.refresh_topic_representation(model, docs, topics, vec)

source = open("scripts/build-topics.py", encoding="utf8").read()
print(json.dumps({
  "calls": len(model.calls),
  "docs": model.calls[0]["docs"],
  "kwargs": {k: v for k, v in model.calls[0]["kwargs"].items() if k != "vectorizer_model"},
  "vectorizerIsStopWordVec": model.calls[0]["kwargs"].get("vectorizer_model") is vec,
  "bareCallRemains": "update_topics(abstracts, topics=topics)" in source,
  "helperUsed": "refresh_topic_representation(topic_model, abstracts, topics," in source,
}))
`);

  assert.equal(result.calls, 1);
  assert.deepEqual(result.docs, ['abstract one', 'abstract two']);
  assert.deepEqual(result.kwargs, { topics: [0, 1] });
  assert.equal(result.vectorizerIsStopWordVec, true);
  assert.equal(result.bareCallRemains, false);
  assert.equal(result.helperUsed, true);
});

const PYTHON_WITH_SKLEARN = (() => {
  for (const py of ['.venv/bin/python', 'python3']) {
    try {
      execFileSync(py, ['-c', 'import sklearn'], { stdio: 'ignore' });
      return py;
    } catch { /* try next */ }
  }
  return null;
})();

const LOAD_BT = `
import importlib.util, json, re, sys
sys.modules["torch"] = None
spec = importlib.util.spec_from_file_location("bt", "scripts/build-topics.py")
bt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bt)
`;

test('topic stop words cover non-English function words and formula placeholders, not English homographs', () => {
  const result = runPythonSnippet(`${LOAD_BT}
words = bt.topic_extra_stop_words()
probe = ["la", "et", "les", "des", "dans", "son", "dun", "cest", "quil", "chapitre", "el", "los", "por", "il", "della", "der", "und", "nicht",
         "omitted", "superscript", "subscript", "let", "thesis", "dissertation",
         "war", "die", "sin", "era", "come", "art", "man", "ai", "eu"]
print(json.dumps({w: w in words for w in probe}))
`);
  for (const w of ['la', 'et', 'les', 'des', 'dans', 'son', 'dun', 'cest', 'quil', 'chapitre', 'el', 'los', 'por', 'il', 'della', 'der', 'und', 'nicht',
    'omitted', 'superscript', 'subscript', 'let', 'thesis', 'dissertation']) {
    assert.equal(result[w], true, `${w} should be a stop word`);
  }
  for (const w of ['war', 'die', 'sin', 'era', 'come', 'art', 'man', 'ai', 'eu']) {
    assert.equal(result[w], false, `${w} should be kept`);
  }
});

test('topic token pattern keeps two-letter words and drops tokens with digits', () => {
  const result = runPythonSnippet(`${LOAD_BT}
print(json.dumps(re.findall(bt.TOPIC_TOKEN_PATTERN, "EU and AI policy in the 1990s: 05 items, p-value x2 école")))
`);
  assert.deepEqual(result, ['EU', 'and', 'AI', 'policy', 'in', 'the', 'items', 'value', 'école']);
});

test('build_topic_vectorizer filters stop words and numeric tokens from topic terms', { skip: PYTHON_WITH_SKLEARN ? false : 'scikit-learn is not installed' }, () => {
  const source = `${LOAD_BT}
vec = bt.build_topic_vectorizer()
vec.fit([
  "La politique de la France et les élections dans le 05 siècle",
  "Let x be omitted superscript subscript in the theorem of 1990s groups",
  "War and the EU in an era of AI",
])
print(json.dumps(sorted(vec.get_feature_names_out().tolist())))
`;
  const terms = JSON.parse(execFileSync(PYTHON_WITH_SKLEARN, ['-c', source], { cwd: process.cwd(), encoding: 'utf8' }));
  assert.deepEqual(terms, ['ai', 'era', 'eu', 'france', 'groups', 'politique', 'siècle', 'theorem', 'war', 'élections']);
});

test('the BERTopic fit uses build_topic_vectorizer', () => {
  const source = readFileSync('scripts/build-topics.py', 'utf8');
  assert.match(source, /vectorizer_model = build_topic_vectorizer\(\)/);
  assert.doesNotMatch(source, /CountVectorizer\(stop_words=stop_words\)/);
});
