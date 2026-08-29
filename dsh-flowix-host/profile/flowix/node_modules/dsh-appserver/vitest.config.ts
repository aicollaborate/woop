import { defineConfig } from 'vitest/config'

// Pin the test root to this bundle. Without a local config vitest walks up and
// inherits the repo root's app/flowix-web-only include list, hiding these tests.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
