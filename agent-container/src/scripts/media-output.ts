import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { modelDetailSchema, savedModelSchema, succeededPredictionSchema } from './media-output-schema';

const SCHEMA_FILE = '.model-schema.json';
const REF_PREFIX = '#/components/schemas/';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Only a declared URI field can produce a file. Free-form metadata and OCR
// text can contain perfectly valid URLs of their own.
function* fileFields(
  value: unknown,
  schema: unknown,
  schemas: Record<string, unknown>,
  seen = new Set<unknown>(),
): Generator<string> {
  if (value == null || !isRecord(schema) || seen.has(schema)) return;
  const visited = new Set(seen).add(schema);
  if (typeof schema.$ref === 'string' && schema.$ref.startsWith(REF_PREFIX)) {
    const name = schema.$ref.slice(REF_PREFIX.length).replace(/~1/g, '/').replace(/~0/g, '~');
    yield* fileFields(value, schemas[name], schemas, visited);
  }
  if (Array.isArray(schema.allOf)) {
    for (const part of schema.allOf) yield* fileFields(value, part, schemas, visited);
  }
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(alternatives)) {
    const type = Array.isArray(value) ? 'array' : typeof value;
    const matching = alternatives.filter((part) => isRecord(part) && (!part.type || part.type === type));
    // A union that could also mean ordinary text supplies no file provenance.
    if (matching.length === 1) yield* fileFields(value, matching[0], schemas, visited);
  }
  if (typeof value === 'string' && schema.format === 'uri') yield value;
  if (Array.isArray(value)) {
    for (const item of value) yield* fileFields(item, schema.items, schemas);
  } else if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const [key, item] of Object.entries(value)) {
      const field = Object.hasOwn(properties, key) ? properties[key] : schema.additionalProperties;
      yield* fileFields(item, field, schemas);
    }
  }
}

function isDeliveryUrl(url: URL): boolean {
  return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
    (url.hostname === 'replicate.delivery' || url.hostname.endsWith('.replicate.delivery'));
}

async function fetchFile(url: URL): Promise<NonNullable<Response['body']>> {
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (!isDeliveryUrl(url)) throw new Error('The file redirected outside the Replicate delivery host.');
    const response = await fetch(url, { redirect: 'manual' });
    if (response.ok && response.body) return response.body;
    await response.body?.cancel();
    const location = response.headers.get('location');
    if (![301, 302, 303, 307, 308].includes(response.status) || !location) {
      throw new Error(`File download returned HTTP ${response.status}.`);
    }
    url = new URL(location, url);
  }
  throw new Error('Too many file redirects.');
}

async function recordModel(directory: string, detail: unknown) {
  const { owner, name, latest_version } = modelDetailSchema.parse(detail);
  const saved = savedModelSchema.parse({ model: `${owner}/${name}`, schemas: latest_version.openapi_schema.components.schemas });
  await writeFile(join(directory, SCHEMA_FILE), JSON.stringify(saved), { flag: 'wx' });
  return saved.schemas;
}

async function saveOutputs(directory: string, prediction: unknown): Promise<void> {
  const { id, model, output } = succeededPredictionSchema.parse(prediction);
  const saved = savedModelSchema.parse(JSON.parse(await readFile(join(directory, SCHEMA_FILE), 'utf8')));
  if (model !== saved.model) throw new Error(`Expected a prediction from ${saved.model}, received ${model}.`);

  const jobDirectory = join(directory, id);
  await mkdir(jobDirectory, { recursive: true });
  const urls = new Set(fileFields(output, saved.schemas.Output, saved.schemas));
  let number = 0;
  for (const raw of urls) {
    const url = URL.parse(raw);
    if (!url || !isDeliveryUrl(url)) continue;
    const destination = join(jobDirectory, `${++number}-${basename(url.pathname) || 'output'}`);
    const temporary = join(jobDirectory, `.${randomUUID()}.part`);
    const body = await fetchFile(url);
    try {
      await pipeline(body, createWriteStream(temporary, { flags: 'wx' }));
      const { size } = await stat(temporary);
      if (!size) throw new Error('Downloaded file was empty.');
      await rename(temporary, destination);
      console.log(`${size} bytes  ${destination}`);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

async function main(): Promise<void> {
  const [, , action, directory] = process.argv;
  if (!directory || (action !== 'schema' && action !== 'save')) {
    throw new Error('Usage: media-output.js <schema|save> <run directory>');
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (action === 'schema') console.log(JSON.stringify(await recordModel(directory, input)));
  else await saveOutputs(directory, input);
}

if (require.main === module) {
  main().catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
