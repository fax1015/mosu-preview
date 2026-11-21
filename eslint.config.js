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
      'no-var': 'error',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-script-url': 'error',
      // `x == null` is the one loose comparison worth keeping: null or undefined.
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  {
    // Extension pages (popup & options) and browser modules.
    files: ['src/**/*.js'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.webextensions },
    },
    rules: {
      // Browser extension modules must never import Node built-ins.
      'no-restricted-imports': ['error', { patterns: ['node:*'] }],
    },
  },
  {
    // Background service worker and its direct extraction/network/cache imports
    // run without DOM globals (`window`, `document`, `Audio`, `localStorage`).
    files: [
      'src/background.js',
      'src/audio/fullAudioExtractionCore.js',
      'src/audio/provider.js',
      'src/audio/cache.js',
      'src/audio/zip.js',
    ],
    languageOptions: {
      globals: { ...globals.serviceworker, ...globals.webextensions },
    },
  },
  {
    // Localhost browser performance harness (not an extension page).
    files: ['scripts/performance-browser.js'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  {
    files: ['tests/**/*.js', 'scripts/**/*.mjs', 'eslint.config.js'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
];
