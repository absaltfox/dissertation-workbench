export const SUPERVISOR_BLOCKED_VALUES = new Set([
  '_',
  '__',
  'n/a',
  'na',
  'unknown',
  'committee',
  'supervisor',
  'additional supervisory committee members:',
  'additional supervisory committee members',
  'examining committee members',
  'examining committee',
  'supervisory committee members',
  'supervisory committee',
  'committee members',
]);

export const SUPERVISOR_CANONICAL_OVERRIDES = new Map([
  ['ellis jason 1981', 'Jason Ellis'],
  ['ellis jason', 'Jason Ellis'],
  ['jason ellis', 'Jason Ellis'],
  ['taylor alison 1959', 'Alison Taylor'],
  ['taylor alison', 'Alison Taylor'],

  // Nickname variants (Tom ↔ Thomas — middle-initial stripping alone can't merge these)
  ['tom sork', 'Tom Sork'],
  ['thomas sork', 'Tom Sork'],

  // Middle-initial variant — key stripping now unifies these, canonical form is shorter name
  ['deirdre kelly', 'Deirdre Kelly'],
]);
