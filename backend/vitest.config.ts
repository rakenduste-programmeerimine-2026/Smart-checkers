import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Käivitusfail ja ekspordid ei sisalda loogikat.
      exclude: ['src/server/main.ts', 'src/index.ts'],
      thresholds: { lines: 90, branches: 85, functions: 90 },
    },
  },
});
