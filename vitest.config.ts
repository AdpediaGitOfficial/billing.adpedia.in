import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  // An inline postcss config stops Vite searching for postcss.config.mjs, whose
  // Tailwind 4 plugin its config scanner cannot load. These tests never touch CSS.
  css: { postcss: { plugins: [] } },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    /**
     * 🔴 20s, not vitest's 5s default.
     *
     * Since docs/59 every `sendInvoice` renders the issued document, which launches a
     * browser and takes roughly 700ms. An integration test that sends three or four
     * invoices therefore sits close to the default, and under load it tips over — which it
     * did, in a test about cancelling receipts that has nothing to do with any of this.
     *
     * Raised rather than hidden: the cost is real and documented in docs/59 §3, and a suite
     * that fails intermittently on timing is one people learn to re-run instead of read.
     */
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
  resolve: { alias: { '@': resolve(__dirname, 'src') } },
})
