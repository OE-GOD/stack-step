import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import jsxA11y from 'eslint-plugin-jsx-a11y'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'playwright-report/**',
      'test-results/**',
      'coverage/**',
      'docs/screenshots/**',
      '.vercel/**',
      '.netlify/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      ecmaVersion: 2023,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      eqeqeq: ['error', 'always'],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Browser code: React rules + accessibility rules.
    files: ['src/**/*.{ts,tsx}'],
    extends: [
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
      jsxA11y.flatConfigs.recommended,
    ],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    // Node code: config files, scripts, serverless functions, end-to-end tests.
    files: ['api/**', 'netlify/**', 'server/**', 'scripts/**', 'e2e/**', '*.config.{ts,js}'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // Playwright code also contains callbacks that run inside the browser page.
    files: ['scripts/**', 'e2e/**'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    // Plain JavaScript files are not part of a TypeScript project.
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  prettier,
)
