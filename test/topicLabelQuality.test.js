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

test('topic label quality gates allow polished compounds but reject keyword lists', () => {
  const result = runPythonSnippet(`
import importlib.util, json
spec = importlib.util.spec_from_file_location("bt", "scripts/build-topics.py")
bt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bt)
print(json.dumps({
  "compound": bt.looks_like_keyword_bag("Student Achievement, Assessment, and Classroom Factors"),
  "keywordList": bt.looks_like_keyword_bag("achievement, mathematics, reading, variables"),
  "choppy": bt.looks_like_keyword_bag("Achievement Mathematics Reading Variables"),
}))
`);

  assert.equal(result.compound, false);
  assert.equal(result.keywordList, true);
  assert.equal(result.choppy, true);
});

test('topic label quality gates flag labels that overfit one document in small topics', () => {
  const result = runPythonSnippet(`
import importlib.util, json
spec = importlib.util.spec_from_file_location("bt", "scripts/build-topics.py")
bt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bt)
evidence = {
  "docCount": 5,
  "titles": [
    "Submissiveness : a re-conceptualized view",
    "Women's and men's networks in the workplace : attitudes, behaviours and outcomes",
    "Parental involvement in career development of children",
    "Same-sex social support and the enhancement of well-being",
    "The concepts of differentiation, enmeshment, and the relationship between them",
  ],
  "documents": [
    {"title": "Submissiveness : a re-conceptualized view", "abstract": "Trait submissiveness and counselling psychology."},
    {"title": "Women's and men's networks in the workplace", "abstract": "Gendered workplace networks and homosociality."},
    {"title": "Parental involvement in career development of children", "abstract": "Family cohesion and adolescent career maturity."},
    {"title": "Same-sex social support and the enhancement of well-being", "abstract": "Same-sex bonding, cross-sex bonding, social relations, and well-being."},
    {"title": "Differentiation and enmeshment", "abstract": "Family theory validation using Q-methodology."},
  ],
}
label, score, warnings = bt.score_label_candidate("Same-Sex Social Support and Well-Being Enhancement", 37)
for warning in bt.evidence_quality_warnings(label, evidence):
  if warning not in warnings:
    warnings.append(warning)
if warnings:
  score = max(score - 25, 0)
print(json.dumps({"label": label, "score": score, "warnings": warnings}))
`);

  assert.equal(result.label, 'Same-Sex Social Support and Well-Being Enhancement');
  assert.ok(result.score < 80);
  assert.ok(result.warnings.includes('small_topic_review'));
  assert.ok(result.warnings.includes('low_label_coverage'));
  assert.ok(result.warnings.includes('overfits_single_document'));
});
