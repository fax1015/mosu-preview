import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['dist/', 'node_modules/', 'performance-results/'],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
    },
    rules: {
      // An empty catch hides failures; one that is deliberate says why in a comment.
      'no-empty': ['error', { allowEmptyCatch: false }],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }],
      'prefer-const': 'error',
      // `x == null` is the one loose comparison worth keeping: null or undefined.
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  {
    // The extension itself: popup, options page and background worker.
    files: ['src/**/*.js', 'scripts/performance-browser.js'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.webextensions },
    },
  },
  {
    files: ['tests/**/*.js', 'scripts/**/*.mjs', 'eslint.config.js'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
];
