import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Catalog writes detect languages, which needs the model loaded.
    setupFiles: ['src/testing/setup.ts'],
  },
})
