import { sxzz } from '@sxzz/eslint-config'

export default sxzz({ vue: true }, [
  {
    rules: {
      // Mark intentionally unawaited UI work without changing its scheduling.
      'no-void': ['error', { allowAsStatement: true }],
    },
  },
  {
    files: ['src/composables/*.ts'],
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
])
