import { z } from 'zod';

const components = z.object({ Output: z.record(z.string(), z.unknown()) }).catchall(z.unknown());

export const modelDetailSchema = z.object({
  owner: z.string().min(1),
  name: z.string().min(1),
  latest_version: z.object({ openapi_schema: z.object({ components: z.object({ schemas: components }) }) }),
});

export const savedModelSchema = z.object({ model: z.string().min(1), schemas: components });

export const succeededPredictionSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  model: z.string().min(1),
  status: z.literal('succeeded'),
  output: z.unknown(),
});
