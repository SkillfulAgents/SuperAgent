import { installNfsShim } from './nfs-shim'

// Installed once per worker, disabled until a measurement enables it.
await installNfsShim()
