import { defineConfig, devices } from '@playwright/test'
import base from './playwright.config'

/**
 * Recording config for the `*.demo.spec.ts` walkthroughs — see the
 * pr-demo-video skill.
 *
 * These are not regression tests. They exist to be watched, so they record
 * video, run one at a time, and never retry. The base config's web project
 * ignores them, so they stay out of the ordinary suite and out of CI.
 * Recordings land under `test-results/`, which is already gitignored: the mp4
 * is uploaded to the PR, never committed.
 */
export default defineConfig({
  ...base,
  testMatch: ['**/*.demo.spec.ts'],
  testIgnore: [],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  projects: [
    {
      name: 'demo',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        video: { mode: 'on', size: { width: 1440, height: 900 } },
        // 'on' would write a large trace zip beside every recording.
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
      },
    },
  ],
})
