import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
