import { describe, it, expect, vi } from 'vitest'

// Real-AWS end-to-end check. Gated by RUN_MICROVM_E2E=1 so it never runs in CI.
// Drives the actual client against a live MicroVM image. Requires AWS creds +
// MICROVM_* env pointing at a runnable agent image (e.g. the poc2 scaffolding):
//
//   RUN_MICROVM_E2E=1 \
//   MICROVM_AWS_REGION=us-east-2 \
//   MICROVM_AGENT_IMAGE_ARN=arn:aws:lambda:us-east-2:<acct>:microvm-image:poc2-agent \
//   MICROVM_AGENT_IMAGE_VERSION=1.0 \
//   MICROVM_EXECUTION_ROLE_ARN=arn:aws:iam::<acct>:role/poc2-mvm-exec \
//   MICROVM_EGRESS_CONNECTOR_ARN=arn:aws:lambda:us-east-2:<acct>:network-connector:nc-... \
//   HOST_PUBLIC_URL=https://dummy \
//   npx vitest run src/shared/lib/container/lambda-microvm-runtime.e2e.test.ts

vi.mock('@shared/lib/llm-provider', () => ({ getActiveLlmProvider: () => ({ getContainerEnvVars: () => ({}) }) }))
vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn(), addErrorBreadcrumb: vi.fn() }))

import { LambdaMicroVmRuntimeClient } from './lambda-microvm-runtime'

const enabled = process.env.RUN_MICROVM_E2E === '1'

describe.skipIf(!enabled)('LambdaMicroVmRuntimeClient e2e (real AWS)', () => {
  it('runs a real MicroVM, serves /health through the proxy, then terminates', async () => {
    const client = new LambdaMicroVmRuntimeClient({ agentId: `e2e-${Date.now()}` })
    try {
      await client.start()
      const info = await client.getInfoFromRuntime()
      expect(info.status).toBe('running')
      const res = await client.fetch('/health')
      expect(res.ok).toBe(true)
      expect(await res.text()).toContain('ok')
    } finally {
      await client.stop()
    }
  }, 360_000)

  // First-touch / steady-state regression guard. Prints per-stage timing so a
  // future slow path (like the once-seen ~17s) is caught and bisected by stage,
  // not just felt. Set MICROVM_E2E_COLD_RUNS to change the sample count.
  it('cold-start series stays in the steady band (start -> /health)', async () => {
    const runs = Number(process.env.MICROVM_E2E_COLD_RUNS || 3)
    const timings: number[] = []
    for (let i = 0; i < runs; i++) {
      const client = new LambdaMicroVmRuntimeClient({ agentId: `e2e-cold-${Date.now()}-${i}` })
      const t0 = Date.now()
      try {
        await client.start()
        const elapsed = Date.now() - t0
        timings.push(elapsed)
        const res = await client.fetch('/health')
        expect(res.ok).toBe(true)
        console.log(`[E2E-COLD ${i}] start -> /health ok: ${elapsed}ms`)
      } finally {
        await client.stop()
      }
    }
    const max = Math.max(...timings)
    console.log(`[E2E-COLD] runs=${timings.join(',')}ms max=${max}ms`)
    // Steady cold start to agent /health is ~5-11s; 30s is a generous regression
    // ceiling (image-version first-touch warmup can be slower — run once after a
    // publish to pre-warm, then this guards the steady path).
    expect(max).toBeLessThan(30_000)
  }, 600_000)

  // Stop means terminate; the next start is a cold boot (no warm resume).
  it('stop terminates; a later start is a cold boot', async () => {
    const client = new LambdaMicroVmRuntimeClient({ agentId: `e2e-terminate-${Date.now()}` })
    try {
      await client.start()
      expect((await client.getInfoFromRuntime()).status).toBe('running')

      await client.stop()
      expect((await client.getInfoFromRuntime()).status).toBe('stopped')

      const t0 = Date.now()
      await client.start()
      const coldMs = Date.now() - t0
      const res = await client.fetch('/health')
      expect(res.ok).toBe(true)
      console.log(`[E2E-TERMINATE] stop -> cold start -> /health ok: ${coldMs}ms`)
      expect(coldMs).toBeLessThan(60_000)
    } finally {
      await client.stop()
    }
  }, 600_000)
})
