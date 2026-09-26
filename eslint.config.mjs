// Flat config for the whole workspace. Type-aware rules are deliberately left
// out: they need a full TypeScript program per package and `pnpm typecheck`
// already covers type errors.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Everything here runs on Node.js.
    languageOptions: { globals: globals.node },
    rules: {
      // `_`-prefixed names mark intentionally unused parameters.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  },
);
