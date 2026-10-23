import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'node_modules/**',
      'data/**',
      'output/**',
      '.worktrees/**',
      '.venv/**',
      '.superpowers/**',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  js.configs.recommended,
  {
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      // Express error handlers and callback signatures keep positional args
      // they don't use; `_` prefix marks those as intentional.
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
        // `({ dropped, ...rest }) => rest` is how fields are stripped from
        // payloads (e.g. buildMetrics in src/metrics.js).
        ignoreRestSiblings: true,
      }],
      // `catch {}` with an explanatory comment is an established pattern here.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['src/**/*.js', 'scripts/**/*.{js,mjs}', 'test/**/*.js', 'e2e/**/*.{js,mjs}', '*.js', '*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        // Loaded as classic scripts from /vendor/*.js (see loadClassicScript
        // in public/app/core.js), not imported.
        Chart: 'readonly',
        d3: 'readonly',
      },
    },
  },
];
