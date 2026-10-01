import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  // An inline postcss config stops Vite searching for postcss.config.mjs, whose
  // Tailwind 4 plugin its config scanner cannot load. These tests never touch CSS.
  css: { postcss: { plugins: [] } },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
  resolve: { alias: { '@': resolve(__dirname, 'src') } },
})
