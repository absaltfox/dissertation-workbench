import { STOP_WORDS } from './config.js';
import { canonicalizeDomainText } from './domainDictionary.js';

const LOW_SIGNAL_HEAD_TOKENS = new Set([
  'higher', 'economic', 'understand', 'understanding', 'experience', 'experiences',
  'influenced', 'influence', 'presents', 'presented', 'furthermore', 'year', 'years',
  'post', 'types', 'type', 'want', 'wants',
  'explores', 'examined', 'governed', 'ensures', 'requires', 'played',
  'included', 'completed', 'witnessed', 'takes', 'suggests', 'indicates',
  'ensuring', 'involving',
  // Third-person singular verbs that are sentence predicates, not noun-phrase heads
  // (e.g. "abstract examines strategies", "thesis discusses students")
  'examines', 'discusses', 'investigates', 'considers', 'contributes', 'uncovers',
  'pervades', 'focuses', 'highlights', 'illustrates', 'argues', 'contends',
  'concludes', 'centres', 'centers', 'uses', 'makes', 'tends', 'seems', 'leads',
  'becomes', 'remains', 'helps', 'needs', 'varies', 'reports',
  // Base-form / simple-present verbs at phrase end
  'think', 'feel', 'know', 'show', 'work', 'move', 'grow', 'view', 'seek',
  'face', 'play', 'hold', 'call', 'turn', 'bring', 'give', 'allow',
  // Past-participle adjectives that signal results/process descriptions
  // (e.g. "phenomena recognized", "implementors guided", "discourses embodied",
  // "unit articulated", "policy operationalized", "literature followed",
  // "information collected", "group scored")
  'recognized', 'guided', 'embodied', 'oriented', 'enabled', 'embedded',
  'framed', 'situated', 'constructed', 'perceived', 'positioned',
  'articulated', 'articulates', 'operationalized', 'operationalizes',
  'conceptualized', 'conceptualizes', 'problematized',
  'analyzed', 'extracted', 'retrieved', 'obtained', 'measured',
  'followed', 'collected', 'gathered', 'administered', 'scored',
  'tested', 'coded', 'rated', 'recorded', 'compiled',
  'employed', 'employing', 'implemented', 'reviewed', 'surveyed', 'adopted',
  'introduced', 'applied', 'confirmed', 'documented', 'reinforced',
  'rejected', 'observed', 'distributed', 'undertaken', 'utilized',
  'initiated', 'assigned', 'categorized', 'classified', 'recommended',
  'strongly', // adverb that always precedes another word, never a concept head
  // Preposition/adverb phrase-enders that indicate sentence fragments
  // (e.g. "society beyond", "unit articulated beyond", "highlights commonalities around")
  'beyond', 'around', 'effective', 'affected', 'toward',
  // Third-person singular verbs (additional)
  'falls', 'rises', 'shows', 'gives', 'takes', 'comes', 'goes', 'runs', 'puts',
  'interact', 'exists', 'occurs', 'appears', 'differs',
  // Present participles that always indicate a participial clause when at phrase end
  // (e.g. "transformative force leading", "primary factor contributing")
  'leading', 'contributing', 'resulting', 'serving', 'allowing', 'causing',
  'producing', 'creating', 'forming', 'shaping',
  // Weak phrase-ending words that indicate sentence fragments or quantified mentions
  // (e.g. "trust many", "grade three", "question will")
  'first', 'second', 'many', 'might', 'will', 'next', 'last', 'once',
  // Adverbs of frequency/degree that mark sentence prose, not concepts
  // (e.g. "coordinators report regularly", "falls predominantly")
  'regularly', 'predominantly', 'frequently', 'consistently', 'significantly',
  // Additional past-participle verbs at phrase end
  'encountered',
]);

const LOW_SIGNAL_ANYWHERE_TOKENS = new Set([
  'better', 'furthermore', 'moreover', 'therefore', 'thus', 'however', 'year', 'years',
  'different', 'british', 'columbia', 'unspecified', 'rather', 'even', 'although',
  'already', 'often', 'particularly',
  // Adverbs that mark sentence prose rather than noun-phrase concepts
  // (e.g. "increasingly playing roles", "highly contextualized", "differently across")
  'increasingly', 'differently', 'highly', 'largely', 'generally', 'typically',
  'commonly', 'rarely', 'mostly', 'primarily', 'mainly', 'directly', 'closely',
  'deeply', 'simply', 'similarly', 'essentially', 'effectively', 'actively',
  'broadly', 'widely', 'regularly', 'predominantly', 'frequently', 'consistently',
  'significantly', 'substantially', 'considerably',
  // Generic academic qualifiers that appear in phrases but add no topical meaning
  // (e.g. "particular point", "ways particular", "specific instance")
  'particular', 'reasonably', 'specific', 'certain',
  // Adverbs that mark epistemic/temporal hedging — signal prose, not concepts
  // (e.g. "potentially oppressive", "initially sorted", "historically public")
  'potentially', 'initially', 'traditionally', 'historically', 'ultimately',
  'previously', 'currently', 'recently', 'actually',
  // Verbs that signal a phrase is a sentence clause, not a noun phrase.
  // These are listed in LOW_SIGNAL_HEAD_TOKENS too, but must also be checked
  // anywhere since they may appear mid-phrase (e.g. "units think critically",
  // "dissertation highlights commonalities", "district using ethnodrama",
  // "suite exploring faculty", "learning involving themes").
  'think', 'highlights', 'argues', 'contends', 'concludes', 'becomes', 'remains',
  'using', 'exploring', 'involving',
  // Specific adverbs that always modify within a clause, not within a noun phrase
  // (e.g. "leading specifically", "situated specifically")
  'specifically',
]);

// Phrases that START with these tokens are verbal or adverbial fragments, not concepts
// (e.g. "using activity theory", "providing legitimacy", "playing roles",
// "reported judgements", "reframing leadership", "perceived intentions")
const LOW_SIGNAL_START_TOKENS = new Set([
  'using', 'providing', 'examining', 'exploring', 'applying', 'explaining',
  'introducing', 'considering', 'addressing', 'presenting', 'discussing',
  'analyzing', 'analysing', 'investigating', 'operationalized', 'beyond',
  'playing', 'reported', 'reframing', 'perceived', 'focused', 'desired',
  'intended', 'centered', 'centred', 'situated',
  'reasonably', 'arguably', 'seemingly', 'notably',
  'broader', 'wider', 'deeper', 'greater', 'lesser', 'further',
  // Third-person verbs that begin verbal predicates when phrase-initial
  'examines', 'discusses', 'identifies', 'analyzed', 'analyzes', 'provided',
  'reporting', 'considers',
  // Temporal/existential adjectives as phrase starters produce non-concept phrases
  // (e.g. "former social", "highest expectation", "overall aims", "proposed solutions")
  'former', 'highest', 'lowest', 'overall', 'previous', 'existing',
  'proposed', 'suggested', 'potential', 'recent', 'creating', 'changing',
  'determining', 'strongly',
  // Base-form verbs as phrase starters (infinitive clause heads)
  // (e.g. "inform ongoing conversations", "exercise gatekeeping responsibilities",
  // "address student professional")
  'inform', 'exercise', 'address', 'engage', 'ensure', 'promote', 'develop',
  'support', 'enable', 'enhance', 'improve', 'increase', 'reduce', 'prevent',
  'identify', 'assess', 'evaluate', 'implement', 'establish', 'maintain',
  'achieve', 'facilitate', 'demonstrate', 'understand', 'explore', 'examine',
  // Adverb starters (frequency/degree adverbs beginning phrase are clause prose)
  // (e.g. "regularly encountering cases", "predominantly falls within")
  'regularly', 'predominantly', 'frequently', 'consistently', 'significantly',
  'substantially', 'considerably',
  // Present-participle starters not already in the list
  'encountering', 'reporting', 'maintaining', 'addressing',
  // Discourse-marker adjective "following" always means "the following X", not a noun phrase
  // (e.g. "following subcategories", "following nominal practice")
  'following',
  // Past-tense/past-participle predicate verbs at phrase start
  // (e.g. "held meaning" from "symbols that held meaning for people")
  'held', 'viewed', 'seen', 'known', 'given', 'drawn', 'taken', 'made',
  'found', 'placed', 'based', 'defined', 'shaped', 'formed',
]);

const LOW_SIGNAL_LOCATION_FRAGMENT_HEADS = new Set([
  'influenced', 'presents', 'presented', 'furthermore', 'suggests', 'indicates'
]);

const LOW_SIGNAL_CONCEPT_TERMS = new Set([
  'analysis indicated',
  'analyses indicated',
  'conceptual framework',
  'data analysis',
  'data collection',
  'data collected',
  'data indicated',
  'data showed',
  'determine whether',
  'findings emerged',
  'findings indicate',
  'findings suggest',
  'focus group',
  'focus groups',
  'high levels',
  'interview data',
  'interview protocol',
  'interview protocols',
  'interview schedule',
  'interview transcripts',
  'major findings',
  'make meaning',
  'results indicate',
  'results indicated',
  'results revealed',
  'results showed',
  'results suggest',
  'results suggested',
  'semi structured',
  'semi structured interview',
  'semi structured interviews',
  'significant changes',
  'significant correlation',
  'significant difference',
  'significant differences',
  'significant effect',
  'significant effects',
  'significant gains',
  'significant interaction',
  'significant main',
  'significant main effect',
  'significant positive',
  'significant relationship',
  'significant relationships',
  'significant treatment',
  'statistically significant',
  'structured interview',
  'structured interview schedule',
  'structured interview technique',
  'theoretical framework',
  'three themes',
  'will help',
  'wide range'
]);

const LOW_SIGNAL_CONCEPT_PATTERNS = [
  /\b(?:results?|findings?|analys(?:is|es)|data)\s+(?:indicat(?:e|ed|es)|show(?:ed|s)?|suggest(?:ed|s)?|reveal(?:ed|s)?|emerg(?:ed|es)?|collected|collection)\b/,
  /\b(?:significant|statistically)\s+(?:difference|differences|relationship|relationships|effect|effects|correlation|interaction|changes?|gains?|positive|treatment|main)\b/,
  /\b(?:interview|interviews|participant|participants?)\s+(?:data|schedule|protocols?|transcripts?|responses?|conducted)\b/,
  /\b(?:theoretical|conceptual)\s+framework\b/,
  /\b(?:determine|investigate|examine|explore)\s+whether\b/,
  /\b(?:first|second|third|fourth|fifth)\s+purpose\b/,
  /\bwill\s+help\b/
];

const LOW_SIGNAL_CONCEPT_ANYWHERE_TOKENS = new Set([
  'across', 'along', 'cannot', 'carefully', 'conducted', 'creates', 'different',
  'diverse', 'emphasized', 'factors', 'feel', 'highlighted', 'impacting',
  'including', 'majority', 'methods', 'numerous', 'participants', 'potential',
  'relative', 'reported', 'respondent', 'respondents', 'subsequent', 'suitable',
  'toward', 'towards', 'transcripts', 'whose'
]);

const LOW_SIGNAL_CONCEPT_HEAD_TOKENS = new Set([
  'cannot', 'conducted', 'creates', 'emphasized', 'feel', 'focused', 'highlighted',
  'included', 'interviews', 'lead', 'meaning', 'presented', 'presents', 'process',
  'reported', 'responses', 'review', 'support', 'time', 'transcriptions',
  'transcripts', 'whose'
]);

const NUMBER_WORDS = new Set([
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
  'eighteen', 'nineteen', 'twenty', 'thirty', 'forty', 'fifty', 'hundred'
]);

export function toArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap((v) => toArray(v));
  if (typeof value === 'string') return [value.trim()].filter(Boolean);
  return [String(value).trim()].filter(Boolean);
}

export function flattenText(value) {
  return toArray(value).join(' ').replace(/\s+/g, ' ').trim();
}

export function extractYear(rawDate) {
  if (!rawDate) return null;
  const match = String(rawDate).match(/(19|20)\d{2}/);
  return match ? Number(match[0]) : null;
}

export function parsePageCount(extentValues) {
  for (const value of extentValues) {
    const txt = String(value).toLowerCase();
    const match = txt.match(/(\d{1,5})\s*(pages?|p\.|leaves?)/);
    if (match) return Number(match[1]);
  }
  return null;
}

export function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4 && !STOP_WORDS.has(token) && !/^\d/.test(token));
}

export function isLowSignalConceptPhrase(phrase) {
  const tokens = String(phrase || '').split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return true;
  // Repeated word: "society society", "change change", "child child interaction"
  if (new Set(tokens).size < tokens.length) return true;
  if (tokens.some((token) => LOW_SIGNAL_ANYWHERE_TOKENS.has(token))) return true;
  const head = tokens[tokens.length - 1];
  if (LOW_SIGNAL_HEAD_TOKENS.has(head)) return true;
  // Verbal/adverbial start: "using activity theory", "providing legitimacy",
  // "exploring whether", "beyond borders" — sentence fragments, not noun phrases
  if (LOW_SIGNAL_START_TOKENS.has(tokens[0])) return true;
  if (tokens[0] === 'columbia') return true;
  if (tokens[0] === 'columbia' && LOW_SIGNAL_LOCATION_FRAGMENT_HEADS.has(head)) return true;
  if (tokens[0] === 'mcfd' && (head === 'furthermore' || head === 'however')) return true;
  return false;
}

export function isLowSignalConceptTerm(phrase) {
  const normalized = String(phrase || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!normalized) return true;
  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (LOW_SIGNAL_CONCEPT_TERMS.has(normalized)) return true;
  if (LOW_SIGNAL_CONCEPT_PATTERNS.some((pattern) => pattern.test(normalized))) return true;
  if (tokens.some((token) => NUMBER_WORDS.has(token) || LOW_SIGNAL_CONCEPT_ANYWHERE_TOKENS.has(token))) return true;
  if (LOW_SIGNAL_CONCEPT_HEAD_TOKENS.has(tokens[tokens.length - 1])) return true;
  return isLowSignalConceptPhrase(normalized);
}

export function topTermsFromText(text, limit = 10) {
  const counts = new Map();
  for (const token of tokenize(text)) {
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([term]) => term);
}

export function countTermsFromText(text) {
  const counts = new Map();
  for (const token of tokenize(text)) {
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  return counts;
}

export function buildDocumentFrequency(records, textForRecord) {
  const df = new Map();
  for (const rec of records) {
    const terms = new Set(tokenize(textForRecord(rec)));
    for (const term of terms) {
      df.set(term, (df.get(term) || 0) + 1);
    }
  }
  return df;
}

export function topTfidfTermsFromText(text, documentFrequency, documentCount, limit = 10) {
  const counts = countTermsFromText(text);
  return Array.from(counts.entries())
    .map(([term, count]) => {
      const df = documentFrequency.get(term) || 0;
      const idf = Math.log((documentCount + 1) / (df + 1)) + 1;
      return { term, score: count * idf, count, idf };
    })
    .sort((a, b) => b.score - a.score || b.count - a.count || a.term.localeCompare(b.term))
    .slice(0, limit)
    .map(({ term }) => term);
}

export function buildWordCloud(records, maxTerms = 70) {
  const textForRecord = (rec) => [rec.title, rec.abstract, rec.subjects.join(' '), rec.program, rec.degree].join(' ');
  const df = buildDocumentFrequency(records, textForRecord);
  const scores = new Map();
  for (const rec of records) {
    for (const [term, count] of countTermsFromText(textForRecord(rec))) {
      const idf = Math.log((records.length + 1) / ((df.get(term) || 0) + 1)) + 1;
      scores.set(term, (scores.get(term) || 0) + count * idf);
    }
  }

  return Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxTerms)
    .map(([term, score]) => ({ term, count: Math.round(score * 10) / 10 }));
}

// Cardinal number words: skip any n-gram window containing one to prevent
// methodology-count phrases like "three schools", "eight coordinators".
const CARDINAL_WORDS = new Set([
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen',
  'twenty', 'thirty', 'forty', 'fifty', 'hundred',
]);

export function extractNgrams(text, n) {
  const words = canonicalizeDomainText(text).split(/\s+/).filter(Boolean);
  const ngrams = [];
  for (let i = 0; i <= words.length - n; i++) {
    const window = words.slice(i, i + n);
    if (window.some((w) =>
      w.length < 4 || STOP_WORDS.has(w) || CARDINAL_WORDS.has(w)
      || /^\d{4}[a-z]?$/.test(w) || /^\d+$/.test(w)
    )) continue;
    const phrase = window.join(' ');
    if (isLowSignalConceptPhrase(phrase)) continue;
    ngrams.push(phrase);
  }
  return ngrams;
}

export function buildNgramCloud(records, maxTerms = 60) {
  const counts = new Map();
  for (const rec of records) {
    const text = [rec.title, rec.abstract, rec.subjects.join(' ')].join(' ');
    const allDocCounts = new Map();
    for (const n of [2, 3, 4]) {
      for (const ngram of extractNgrams(text, n)) {
        allDocCounts.set(ngram, (allDocCounts.get(ngram) || 0) + 1);
      }
    }
    const allEntries = Array.from(allDocCounts.entries())
      .map(([term, count]) => ({ term, count, tokens: term.split(' ') }))
      .sort((a, b) => b.tokens.length - a.tokens.length || b.count - a.count);
    const kept = [];
    for (const entry of allEntries) {
      const isSubphrase = kept.some((longer) => {
        if (longer.tokens.length <= entry.tokens.length) return false;
        const maxStart = longer.tokens.length - entry.tokens.length;
        for (let start = 0; start <= maxStart; start++) {
          let ok = true;
          for (let i = 0; i < entry.tokens.length; i++) {
            if (longer.tokens[start + i] !== entry.tokens[i]) {
              ok = false;
              break;
            }
          }
          if (ok) return true;
        }
        return false;
      });
      if (!isSubphrase) kept.push(entry);
    }

    for (const entry of kept) {
      if (entry.tokens.length > 3) continue;
      const { term, count } = entry;
      if (!isLowSignalConceptPhrase(term)) {
        counts.set(term, (counts.get(term) || 0) + count);
      }
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxTerms)
    .map(([term, count]) => ({ term, count }));
}

export const METHODOLOGY_KEYWORDS = new Map([
  ['Qualitative', /\bqualitative\b/i],
  ['Quantitative', /\bquantitative\b/i],
  ['Mixed Methods', /\bmixed[- ]methods?\b/i],
  ['Case Study', /\bcase\s+stud(?:y|ies)\b/i],
  ['Ethnography', /\bethnograph(?:y|ic)\b/i],
  ['Grounded Theory', /\bgrounded\s+theory\b/i],
  ['Phenomenology', /\bphenomenolog(?:y|ical)\b/i],
  ['Action Research', /\baction\s+research\b/i],
  ['Narrative Inquiry', /\bnarrative\s+(?:inquiry|research|analysis)\b/i],
  ['Survey', /\bsurveys?\b/i],
  ['Experimental', /\bexperimental\b/i],
  ['Longitudinal', /\blongitudinal\b/i],
  ['Content Analysis', /\bcontent\s+analysis\b/i],
  ['Discourse Analysis', /\bdiscourse\s+analysis\b/i],
  ['Document Analysis', /\bdocument(?:ary)?\s+analysis\b/i],
  ['Systematic Review', /\bsystematic\s+review\b/i],
  ['Meta-Analysis', /\bmeta[- ]analysis\b/i],
  ['Thematic Analysis', /\bthematic\s+analysis\b/i],
  ['Historical Research', /\bhistorical\s+(?:research|analysis|study|method)\b/i],
  ['Interviews', /\binterview(?:s|ing)?\b/i],
  ['Autoethnography', /\bautoethnograph(?:y|ic)\b/i],
  ['Participatory', /\bparticipatory\b/i],
]);

export function detectMethodologies(text) {
  const str = String(text || '');
  const matched = [];
  for (const [label, regex] of METHODOLOGY_KEYWORDS) {
    const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
    const matcher = new RegExp(regex.source, flags);
    for (const match of str.matchAll(matcher)) {
      const context = str.slice(Math.max(0, match.index - 40), match.index).toLowerCase();
      if (/\b(?:not|no|without|neither|never|does\s+not|did\s+not|do\s+not|was\s+not|were\s+not|is\s+not|are\s+not)\b[\w\s-]{0,35}$/.test(context)) continue;
      matched.push(label);
      break;
    }
  }
  return matched;
}

export function buildMethodologyStats(records) {
  const counts = new Map();
  for (const rec of records) {
    const text = [rec.title, rec.abstract, rec.subjects.join(' ')].join(' ');
    for (const label of detectMethodologies(text)) {
      counts.set(label, (counts.get(label) || 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([methodology, count]) => ({ methodology, count }));
}
