import * as fs from 'fs/promises';
import * as path from 'path';
import { volumeRecoveryManifestSchema, type ContainerMount } from './volume-mounts-schema';

/** Keep cached writes on the workspace filesystem even if the agent API or
 * rclone dies. Each generation is isolated: old writes are never replayed over
 * newer remote edits automatically. */
export async function createVolumeCache(volume: ContainerMount, workspace = '/workspace'): Promise<string> {
  const root = path.join(workspace, '.volume-cache');
  await fs.mkdir(root, { recursive: true });
  const cache = await fs.mkdtemp(path.join(root, `${volume.volumeId}-`));
  const manifest = volumeRecoveryManifestSchema.parse({
    version: 1, volumeId: volume.volumeId, mountPath: `/mounts/${volume.name}`, createdAt: new Date().toISOString(),
  });
  await fs.writeFile(path.join(cache, 'volume.json'), JSON.stringify(manifest, null, 2));
  return cache;
}

/** Rename the entire cache, including rclone's range/dirty metadata. Copying
 * through FUSE can hang on an unavailable provider or turn sparse cached reads
 * into corrupt "complete" files. A same-filesystem rename also handles huge
 * queued files without copying their bytes during shutdown. */
export async function preserveVolumeCache(cache: string): Promise<string> {
  const workspace = path.dirname(path.dirname(cache));
  const recoveryRoot = path.join(workspace, 'recovered-volume-uploads');
  await fs.mkdir(recoveryRoot, { recursive: true });
  const destination = path.join(recoveryRoot, path.basename(cache));
  await fs.rename(cache, destination);
  return destination;
}
