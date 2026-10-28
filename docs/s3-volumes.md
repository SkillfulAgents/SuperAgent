# S3-compatible volumes

A saved S3 volume mounts one bucket or folder prefix at `/mounts/<name>`. It works through the same WebDAV, rclone `mount2`, upload recovery, assignment, and tabbed browsing paths as other remote volumes. The host signs requests with AWS SDK v3; containers never receive S3 credentials. No Composio connection is involved.

## Connect

Choose **S3-compatible bucket** in New Volume. Provide the bucket, region, access key ID, and secret access key. For Amazon S3, leave Endpoint URL blank. For R2, use the account’s S3 API endpoint; the dialog selects region `auto`. Custom HTTPS endpoints, optional session tokens, and path-style/virtual-host bucket addressing are supported. A prefix limits every operation to that folder; an empty prefix mounts the bucket root. HTTP endpoints are supported for local services and show an unencrypted-connection warning.

**Test connection** checks listing, creation, overwrite, reading, conditional writes, server-side copy, multipart completion, multipart abort, and deletion. The checks create unique `.gamut-check-<uuid>/` objects within the selected prefix, then remove them. Missing permissions are shown per operation. If deletion or abort is denied, the result identifies the probe objects/uploads to clean up. Creation repeats validation on the server, so bypassing the dialog cannot save an unchecked connection.

AWS policies need `s3:ListBucket` on the bucket (restricted to the selected prefix if desired), and `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`, and `s3:AbortMultipartUpload` on its objects. `CopyObject` and multipart create/complete use the corresponding object read/write permissions. For R2, use **Object Read & Write**, restricted to the bucket. Bucket enumeration, IAM inspection, ACL access, and bucket administration are not required. A successful probe confirms access to its test keys, not that every existing object’s ACL, retention policy, or encryption key permits changes. Temporary session credentials must be replaced when they expire; automatic refresh is not supported.

Credentials are AES-256-GCM encrypted in the volume definition, using a key derived from the deployment’s existing auth secret and bound to the endpoint, region, bucket, prefix, and addressing mode. API summaries and container configurations omit credentials. Back up `.auth-secret` (or the configured `BETTER_AUTH_SECRET`) with the database. Rotating or losing it requires reconnecting S3 volumes. The host necessarily holds the decrypted key while signing a request. Changing credentials currently requires recreating the definition.

## Filesystem behavior

- Keys are case-sensitive. Directories are prefixes, with zero-byte trailing-slash markers to preserve empty folders. Removing the last child preserves its parent directory.
- Listings use paginated `ListObjectsV2` with delimiters and the shared bounded 15-second listing cache. File stat and reads use fresh metadata; downloads are pinned by ETag and support ranges. Advisory health is cached for a minute.
- Files through 8 MiB use one content PUT. Larger bodies stream in 8 MiB multipart chunks, outside namespace locks; only final publication claims the path. Failed/canceled uploads abort their multipart session. The current streaming limit is 10,000 parts (about 78 GiB).
- Conditional PUT/completion protects concurrent overwrites. Sibling mutations can run concurrently; folder mutations wait for overlapping descendant mutations across mounts on the same endpoint/bucket.
- Renaming uses server-side copy followed by delete, replacing existing files without deleting the destination first. Directory renames copy all members before removing sources. Files above 5 GiB use multipart copy. S3 has no portable atomic directory rename: interrupted renames can leave duplicates or a partially moved tree. External writers can still race copy/delete on compatible providers that ignore destination/delete conditions; a fresh source ETag check reduces this window. Treat these mounts as shared object storage, not a transactional database filesystem.
- Object keys that cannot be represented as filesystem paths (dot segments, repeated slashes, control characters) are not browsable. Nonzero directory markers and file/folder name collisions are refused by destructive operations. Empty-directory deletion checks raw keys, including hidden/unrepresentable children.
- Safe reads retry temporary failures with the shared request pacer. Explicit throttles respect `Retry-After`; uncertain mutating requests are not replayed. Only published mutations are audited; live filesystem calls emit no product analytics.
- The shared failed-upload guard blocks rclone’s cleanup DELETE from erasing a preserved file. An intentional deletion after a failed upload may require one retry. Normal bounded stop/drain and workspace recovery apply unchanged.

Standard S3 buckets are supported; S3 Express directory buckets and per-object encryption-key entry are outside this setup flow. Versioned buckets retain historical versions/delete markers according to their existing policies. Configure a lifecycle rule for abandoned multipart uploads as a backstop for host/network crashes.

## Tests

S3 runs all 27 cases in `testing/volume-contract.ts`, plus wire-level SDK, object-store behavior, permission-validation, credential encryption, API authorization, and renderer tests. API/database coverage also runs on libSQL.

The opt-in live suite exercises a disposable prefix and a real rclone mount using an existing agent image:

```sh
set -o pipefail
S3_TEST_CONFIG=/absolute/path/to/private-test-config.json \
S3_TEST_IMAGE=your-existing-agent-image \
npx vitest run src/shared/lib/volumes/s3-live.e2e.test.ts 2>&1 | tee /tmp/s3-live-e2e.txt
```

The JSON uses the setup schema (`endpoint`, `region`, `bucket`, a nonempty `prefix`, `forcePathStyle`, and `credentials` with `accessKeyId`/`secretAccessKey`). Keep it outside the repository with mode 0600. Every run creates a random child prefix and cleans only its own objects and multipart uploads. FUSE verification compares the remote bytes directly, independently of rclone’s VFS cache. The cleanup harness additionally needs multipart-list and multi-object-delete access.

References: [R2 S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/), [S3 conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html), [S3 multipart upload](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html).
