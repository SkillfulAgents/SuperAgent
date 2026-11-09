/** `cloudflare:workers` under Node, for tests: just enough to load src/cf's Durable Objects. */
export class DurableObject<Env = unknown> {
  constructor(
    protected readonly ctx: unknown,
    protected readonly env: Env,
  ) {}
}
