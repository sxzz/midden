import { sxzz } from '@sxzz/eslint-config'
import { noClickNavigation } from './scripts/no-click-navigation.ts'

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
    // Vendored upstream sources keep their own formatting for easier diffs;
    // migrations are generated and maintained by drizzle-kit.
    { ignores: ['third_party/**', 'server/drizzle/**'] },
    {
      files: ['web/**'],
      rules: {
        // Mark intentionally unawaited UI work without changing its scheduling.
        'no-void': ['error', { allowAsStatement: true }],
      },
    },
    {
      // Navigation is a link, so a modified click opens a new tab; see the
      // rule for what stays programmatic.
      files: ['web/src/**/*.vue'],
      // The link primitive is where a click becomes navigation.
      ignores: ['web/src/components/ui/AppLink.vue'],
      plugins: {
        midden: { rules: { 'no-click-navigation': noClickNavigation } },
      },
      rules: { 'midden/no-click-navigation': 'error' },
    },
    {
      files: ['web/src/composables/*.ts'],
      rules: {
        // Vue composables conventionally use useSomething filenames.
        'unicorn/filename-case': ['error', { case: 'camelCase' }],
      },
    },
    {
      // Runs only on Node 26; browser baseline does not apply.
      files: ['server/**', 'scripts/**'],
      rules: { 'baseline-js/use-baseline': 'off' },
    },
    {
      // Carried over from the gRPC adapters; these rules only restyle it.
      files: ['server/src/platforms/**'],
      rules: {
        'e18e/prefer-static-regex': 'off',
        'unicorn/error-message': 'off',
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
