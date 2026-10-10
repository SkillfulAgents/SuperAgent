import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createVolumeCache, preserveVolumeCache } from './volume-recovery';
import { volumeRecoveryManifestSchema } from './volume-mounts-schema';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });
async function workspace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'volume-recovery-'));
  directories.push(dir);
  return dir;
}
const volume = { volumeId: 'v_docs', name: 'Documents', cacheMode: 'remote' as const };

describe('workspace upload recovery', () => {
  it('moves bytes and range metadata together without copying or overwriting another generation', async () => {
    const root = await workspace();
    const cache = await createVolumeCache(volume, root);
    const newer = await createVolumeCache(volume, root);
    await fs.mkdir(path.join(cache, 'vfs', 'remote'), { recursive: true });
    await fs.mkdir(path.join(cache, 'vfsMeta', 'remote'), { recursive: true });
    const bytes = Buffer.from([0, 255, 128, 1]);
    const source = path.join(cache, 'vfs', 'remote', 'queued.bin');
    await fs.writeFile(source, bytes);
    await fs.writeFile(path.join(cache, 'vfsMeta', 'remote', 'queued.bin'), 'range metadata');
    const inode = (await fs.stat(source)).ino;
    const recovered = await preserveVolumeCache(cache);
    const file = path.join(recovered, 'vfs', 'remote', 'queued.bin');
    expect((await fs.stat(file)).ino).toBe(inode);
    expect(await fs.readFile(file)).toEqual(bytes);
    expect(await fs.readFile(path.join(recovered, 'vfsMeta', 'remote', 'queued.bin'), 'utf8')).toBe('range metadata');
    const manifest = volumeRecoveryManifestSchema.parse(JSON.parse(await fs.readFile(path.join(recovered, 'volume.json'), 'utf8')));
    expect(manifest.mountPath).toBe('/mounts/Documents');
    expect(await fs.readdir(path.join(root, '.volume-cache'))).toEqual([path.basename(newer)]);
  });

  it('keeps the original durable cache when promotion fails', async () => {
    const root = await workspace();
    const cache = await createVolumeCache(volume, root);
    await fs.writeFile(path.join(cache, 'queued.txt'), 'only copy');
    await fs.writeFile(path.join(root, 'recovered-volume-uploads'), 'blocked');
    await expect(preserveVolumeCache(cache)).rejects.toThrow();
    expect(await fs.readFile(path.join(cache, 'queued.txt'), 'utf8')).toBe('only copy');
  });
});
