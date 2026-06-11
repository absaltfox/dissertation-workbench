import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectDownloadBlockPage,
  parseAcknowledgements,
  parseCommittee,
  parseBibliography,
  extractBodyWordCount
} from '../src/pdf.js';

test('detectDownloadBlockPage identifies UBC/F5 security block HTML', () => {
  const html = `
    <h4>Sorry for the inconvenience.</h4>
    <p>Your request was blocked because our system detected unusual activity.</p>
    <p>Reference ID: ITSA - <12345></p>
  `;

  assert.equal(detectDownloadBlockPage(html), true);
  assert.equal(detectDownloadBlockPage('<html><a href="/file.pdf">Download</a></html>'), false);
});

test('parseAcknowledgements extracts supervisors, co-supervisors, and committee members', () => {
  // Test case 1: Singular supervisor and committee members listing
  const ackText1 = `ACKNOWLEDGEMENTS
First, I would like to express my supervisor, Dr. Jane Smith, for her patience...
I also thank my committee members: Dr. Robert Brown and Dr. Lily White.
They provided invaluable support throughout my entire doctoral journey.
Without their constant feedback and encouragement, this thesis would not have been possible.`;

  const res1 = parseAcknowledgements(ackText1);
  assert.ok(res1.some((m) => m.name === 'Jane Smith' && m.role === 'Supervisor'));
  assert.ok(res1.some((m) => m.name === 'Robert Brown' && m.role === 'Supervisory Committee Member'));
  assert.ok(res1.some((m) => m.name === 'Lily White' && m.role === 'Supervisory Committee Member'));

  // Test case 2: Plural co-supervisors
  const ackText2 = `ACKNOWLEDGEMENTS
I would like to thank my supervisors, Dr. Alan Doe and Dr. Bob Jones, for their guidance.
They provided invaluable support throughout my entire doctoral journey.
Without their constant feedback and encouragement, this thesis would not have been possible.`;

  const res2 = parseAcknowledgements(ackText2);
  assert.ok(res2.some((m) => m.name === 'Alan Doe' && m.role === 'Co-Supervisor'));
  assert.ok(res2.some((m) => m.name === 'Bob Jones' && m.role === 'Co-Supervisor'));

  // Test case 3: Parenthesised roles
  const ackText3 = `ACKNOWLEDGEMENTS
Thank you to Dr. John Watson (Supervisor) and Dr. Sherlock Holmes (Co-Supervisor).
They provided invaluable support throughout my entire doctoral journey.
Without their constant feedback and encouragement, this thesis would not have been possible.`;

  const res3 = parseAcknowledgements(ackText3);
  assert.ok(res3.some((m) => m.name === 'John Watson' && m.role === 'Supervisor'));
  assert.ok(res3.some((m) => m.name === 'Sherlock Holmes' && m.role === 'Co-Supervisor'));

  // Test case 4: Bare name list (consisting of...)
  const ackText4 = `ACKNOWLEDGEMENTS
I am grateful to my research committee consisting of Tom Sork, Pierre Walter and Robert VanWynsberghe.
They provided invaluable support throughout my entire doctoral journey.
Without their constant feedback and encouragement, this thesis would not have been possible.`;

  const res4 = parseAcknowledgements(ackText4);
  assert.ok(res4.some((m) => m.name === 'Tom Sork' && m.role === 'Supervisory Committee Member'));
  assert.ok(res4.some((m) => m.name === 'Pierre Walter' && m.role === 'Supervisory Committee Member'));
  assert.ok(res4.some((m) => m.name === 'Robert VanWynsberghe' && m.role === 'Supervisory Committee Member'));
});

test('parseCommittee parses different layout structures from exam cert pages', () => {
  // Test case 1: Pre-2016 format (name above role label)
  const committeeText1 = `The following individuals certify that they have read, and recommend to the Faculty of Graduate and Postdoctoral Studies...
John Smith, Professor, UBC
Supervisor
Alice Cooper, Associate Professor, SFU
Co-Supervisor`;

  const res1 = parseCommittee(committeeText1);
  assert.ok(res1.some((m) => m.name === 'John Smith' && m.role === 'Supervisor'));
  assert.ok(res1.some((m) => m.name === 'Alice Cooper' && m.role === 'Co-Supervisor'));

  // Test case 2: 2018+ format (role label above name)
  const committeeText2 = `The following individuals certify that they have read, and recommend to the Faculty...
Supervisor
John Smith, Professor, UBC
Co-Supervisor
Alice Cooper, SFU`;

  const res2 = parseCommittee(committeeText2);
  assert.ok(res2.some((m) => m.name === 'John Smith' && m.role === 'Supervisor'));
  assert.ok(res2.some((m) => m.name === 'Alice Cooper' && m.role === 'Co-Supervisor'));

  // Test case 3: 2019+ inline parenthesized format
  const committeeText3 = `The following individuals certify that they have read...
Tracy Friedel (Co-Supervisor)
Bob Dylan (Supervisor)`;

  const res3 = parseCommittee(committeeText3);
  assert.ok(res3.some((m) => m.name === 'Tracy Friedel' && m.role === 'Co-Supervisor'));
  assert.ok(res3.some((m) => m.name === 'Bob Dylan' && m.role === 'Supervisor'));
});

test('parseBibliography extracts lists of references and cleans OCR spacing artifacts', () => {
  const bibText = `Some introductory text about education.
REFERENCES

Smith, J. (2012). Learning Educational Theory. Journal of Education, 12(3), 45-67.

J o n e s, A. (2015). P r o f e s s i o n a l  Development of Teachers. Higher Education Press.`;

  const res = parseBibliography(bibText);

  assert.equal(res.length, 2);
  assert.ok(res[0].includes('Smith, J. (2012). Learning Educational Theory'));
  // Confirm OCR space collapse logic (e.g. "P r o f e s s i o n a l" -> "Professional")
  assert.ok(res[1].includes('Jones, A. (2015)'));
  assert.ok(res[1].includes('Professional  Development of Teachers'));
});

test('extractBodyWordCount excludes the bibliography section', () => {
  const fullText = `Introduction to the dissertation.
This is the body text which has some words in it.
These words should be counted towards the body word count.
REFERENCES
Smith, J. (2012). Some paper.
Jones, A. (2015). Another paper.`;

  const totalWords = fullText.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean).length;
  const bodyWords = extractBodyWordCount(fullText);

  assert.ok(bodyWords < totalWords, `Expected body word count (${bodyWords}) to be less than total word count (${totalWords})`);
  assert.equal(bodyWords, 25); // Words: "Introduction to the dissertation. This is the body text which has some words in it. These words should be counted towards the body word count." -> 25 words
});
