// Fixture corpus data only. Deliberately import-free: Playwright spec files
// import this in the test-runner process, and pulling in src/ there would run
// src/env.js and load the developer's .env (Turso URL included) into the runner.
export const FIXTURE_DOCS = [
  { id: 'e2e-doc-1', title: 'Teaching Mathematics Through Play', author: 'Avery Author', year: 2016, degree: 'Doctor of Philosophy - PhD', program: 'Curriculum Studies', supervisors: ['Jane Supervisor'], conceptTerms: ['mathematics education', 'play-based learning'], methodologies: ['Case Study'], pages: 210, words: 62000 },
  { id: 'e2e-doc-2', title: 'Indigenous Land-Based Pedagogy', author: 'Blake Author', year: 2018, degree: 'Doctor of Philosophy - PhD', program: 'Educational Studies', supervisors: ['Jane Supervisor'], conceptTerms: ['land-based pedagogy', 'indigenous education'], methodologies: ['Narrative Inquiry'], pages: 245, words: 71000 },
  { id: 'e2e-doc-3', title: 'Assessment Practices in Secondary Science', author: 'Casey Author', year: 2019, degree: 'Doctor of Education - EdD', program: 'Educational Leadership', supervisors: ['Alex Supervisor'], conceptTerms: ['classroom assessment', 'science education'], methodologies: ['Survey'], pages: 180, words: 54000 },
  { id: 'e2e-doc-4', title: 'Teacher Identity and Early Career Attrition', author: 'Dana Author', year: 2021, degree: 'Doctor of Philosophy - PhD', program: 'Curriculum Studies', supervisors: ['Alex Supervisor'], conceptTerms: ['teacher identity', 'mathematics education'], methodologies: ['Interview'], pages: 230, words: 66000 },
  { id: 'e2e-doc-5', title: 'Digital Literacies in Rural Schools', author: 'Emery Author', year: 2023, degree: 'Master of Arts - MA', program: 'Language and Literacy Education', supervisors: ['Morgan Supervisor'], conceptTerms: ['digital literacy'], methodologies: ['Ethnography'], pages: 120, words: 38000 },
];
