/**
 * One-time links that let an invited person claim their account with a
 * password (team directories: the link goes out in a Slack DM, so holding it
 * shows they are that directory person). Stored as a SHA-256 digest in Better
 * Auth's `verification` table under our own prefix; the token itself is only
 * in the link. Every token of a person goes once they claim.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { and, eq, gt, like } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { verification } from '@shared/lib/db/schema'

const PREFIX = 'team-invite:'
export const INVITE_TOKEN_TTL_MS = 30 * 24 * 60 * 60_000

const identifier = (token: string) => `${PREFIX}${createHash('sha256').update(token).digest('base64url')}`

/** A new link token for `userId`. Earlier ones stay valid until they expire or the person claims. */
export async function mintInviteToken(userId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url')
  const now = new Date()
  await db.insert(verification).values({
    id: randomUUID(),
    identifier: identifier(token),
    value: userId,
    expiresAt: new Date(now.getTime() + INVITE_TOKEN_TTL_MS),
    createdAt: now,
    updatedAt: now,
  }).run()
  return token
}

/** The user a live token was minted for, or null. */
export async function readInviteToken(token: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null
  const row = await db.select({ userId: verification.value }).from(verification)
    .where(and(eq(verification.identifier, identifier(token)), gt(verification.expiresAt, new Date()))).get()
  return row?.userId ?? null
}

/** Removes every token of `userId`: they have joined. */
export async function revokeInviteTokens(userId: string): Promise<void> {
  await db.delete(verification).where(and(like(verification.identifier, `${PREFIX}%`), eq(verification.value, userId))).run()
}
