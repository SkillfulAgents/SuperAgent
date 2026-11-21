import { PNG } from 'pngjs/browser'
import { heicToJpegInWorkerThread } from './heic-worker-thread'

/**
 * The image conversions the app runs. Desktop and the Node host run them in this process, HEIC in
 * a worker thread. A deployment that cannot, such as one without worker threads, passes its own
 * service to `setImageService` at boot.
 */
export interface ImageService {
  /** The first image of a HEIC or HEIF file as a JPEG. It takes `input`, so the caller must not use it afterwards. */
  heicToJpeg(input: Uint8Array): Promise<Uint8Array<ArrayBuffer>>
  /** The same PNG decoded and encoded again, so no ancillary chunks from `input` are kept. */
  cleanPng(input: Uint8Array): Promise<Uint8Array>
}

const localImageService: ImageService = {
  heicToJpeg: heicToJpegInWorkerThread,
  async cleanPng(input) {
    const decoded = PNG.sync.read(Buffer.from(input.buffer, input.byteOffset, input.byteLength), { checkCRC: true })
    const clean = new PNG({ width: decoded.width, height: decoded.height })
    clean.data = decoded.data
    return Buffer.from(PNG.sync.write(clean))
  },
}
let current: ImageService = localImageService

/** Set once at boot by a deployment with its own service. A test passes null to go back to the local one. */
export function setImageService(service: ImageService | null): void {
  current = service ?? localImageService
}

export function imageService(): ImageService {
  return current
}
