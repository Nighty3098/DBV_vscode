import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/core/**/*.ts', 'src/extension/drivers/sqlite.ts'],
      thresholds: {
        statements: 100,
        branches: 90,
        functions: 100,
        lines: 100,
      },
    },
  },
});
