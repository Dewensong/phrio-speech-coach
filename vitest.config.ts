import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    clearMocks: true,
    // Keep jsdom and sparse-file fixtures below the point where worker
    // contention starves their own async state transitions. GitHub's standard
    // Apple Silicon runner currently has fewer cores than this development Mac.
    maxWorkers: 2,
    // The Apple Silicon hosted runner has fewer cores than the primary
    // development Mac. Keep a bounded ceiling that tolerates parallel jsdom
    // and sparse-file fixtures under load without masking a genuine hang.
    testTimeout: 15_000,
  },
});
