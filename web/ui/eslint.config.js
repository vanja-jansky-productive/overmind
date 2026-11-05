// ESLint runs only the React Compiler's rules (eslint-plugin-react-hooks `recommended-latest`, #39):
// code they flag is code the compiler skips or may miscompile. Everything else is oxlint's
// (.oxlintrc.json), including rules-of-hooks; exhaustive-deps stays off as before.
import tsParser from '@typescript-eslint/parser'
import reactHooks from 'eslint-plugin-react-hooks'

const { rules } = reactHooks.configs['recommended-latest']

export default [
  { ignores: ['dist/**', 'node_modules/**'] },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true } } },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...rules,
      'react-hooks/rules-of-hooks': 'off',
      'react-hooks/exhaustive-deps': 'off',
    },
  },
]
