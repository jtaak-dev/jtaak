import { configDefaults, defineConfig } from 'vitest/config';

// Two projects, run one after the other by `pnpm test`: "unit", then
// "containers", the tests against real brokers in containers
// (*.containers.test.ts, see src/test/containers.ts). Kept apart so brokers
// starting up don't slow the performance-budget tests.
export default defineConfig({
  test: {
    environment: 'node',
    projects: [
      {
        extends: true,
        test: { name: 'unit', exclude: [...configDefaults.exclude, '**/*.containers.test.ts'] },
      },
      {
        extends: true,
        test: { name: 'containers', include: ['src/**/*.containers.test.ts'] },
      },
    ],
  },
});
