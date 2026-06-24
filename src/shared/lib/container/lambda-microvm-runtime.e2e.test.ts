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

  // Verifies the auto-sleep contract end-to-end: idle stop suspends (not
  // terminates), and the SAME VM auto-resumes on demand far faster than a cold
  // start would.
  //
  // Two deliberate choices keep this faithful to production rather than to a
  // worst-case race:
  //  1. Wait for the VM to settle into SUSPENDED before resuming. stop() issues
  //     SuspendMicrovm and returns without waiting, so an immediate request races
  //     a still-SUSPENDING VM — a worst case that never happens in production,
  //     where requests arrive long after the VM has settled.
  //  2. Measure time-to-healthy via waitForHealthy (kick + poll), not a single
  //     fetch. The first request to a suspended VM triggers the async resume and
  //     may itself 502 before the agent is back; what matters is how quickly the
  //     agent becomes serveable, which is what a real caller (and the host) sees.
  it('auto-sleep suspends, then auto-resumes faster than cold start', async () => {
    const client = new LambdaMicroVmRuntimeClient({ agentId: `e2e-resume-${Date.now()}` })
    try {
      await client.start()
      expect((await client.getInfoFromRuntime()).status).toBe('running')

      await client.stop({ escalateToForceStop: false }) // auto-sleep -> suspend
      // Let the suspend settle (SuspendMicrovm completes in ~1s); the client maps
      // SUSPENDED/SUSPENDING to 'running' since the VM auto-resumes on demand.
      await new Promise((r) => setTimeout(r, 10_000))
      expect((await client.getInfoFromRuntime()).status).toBe('running')

      const t0 = Date.now()
      const healthy = await client.waitForHealthy(30_000) // kick + poll until agent serveable
      const resumeMs = Date.now() - t0
      expect(healthy).toBe(true)
      console.log(`[E2E-RESUME] suspend -> agent healthy (auto-resume): ${resumeMs}ms`)
      expect(resumeMs).toBeLessThan(15_000)
    } finally {
      await client.stop() // explicit terminate to free the VM
    }
  }, 600_000)
})
