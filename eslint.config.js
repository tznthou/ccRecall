import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['hooks/**/*.{js,mjs}'],
    languageOptions: {
      globals: {
        Buffer: 'readonly',
        URLSearchParams: 'readonly',
        console: 'readonly',
        process: 'readonly',
      },
    },
  },
  {
    // .claude/ is Claude Code's local working directory — gitignored, never
    // part of the package, and holding one-off analysis harnesses rather than
    // project source. Linting it reported 16 errors nobody could act on, since
    // fixing throwaway scratch files benefits no one and the next session
    // writes new ones.
    ignores: ['dist/', 'node_modules/', '.claude/'],
  },
)
