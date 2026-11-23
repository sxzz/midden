import { sxzz } from '@sxzz/eslint-config'

export default sxzz(
  {
    vue: true,
    baseline: {
      // window.open is flagged through the whole Window interface, but the
      // members used here have been supported everywhere for years.
      ignoreFeatures: ['functions-caller-arguments', 'window'],
    },
  },
  [
    // Vendored upstream sources keep their own formatting for easier diffs.
    { ignores: ['third_party/**'] },
    {
      files: ['web/**'],
      rules: {
        // Mark intentionally unawaited UI work without changing its scheduling.
        'no-void': ['error', { allowAsStatement: true }],
      },
    },
    {
      files: ['web/src/composables/*.ts'],
      rules: {
        // Vue composables conventionally use useSomething filenames.
        'unicorn/filename-case': ['error', { case: 'camelCase' }],
      },
    },
    {
      files: ['**/*.test.ts'],
      rules: {
        // Async mocks keep the API's Promise contract; fixtures may be partial.
        'require-await': 'off',
        '@typescript-eslint/consistent-type-assertions': [
          'error',
          {
            assertionStyle: 'as',
            objectLiteralTypeAssertions: 'allow',
          },
        ],
      },
    },
  ],
)
