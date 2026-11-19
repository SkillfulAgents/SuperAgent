import { agentCatalog } from '@shared/lib/agent-actor'
import { agentCreationReceiptKey, agentCreationReceiptSchema } from '@shared/lib/app-records/record-schemas'
import { compareAndSetRecord, readRecord, serializeRecordValue } from '@shared/lib/app-records/records'
import type { CreateAgentInput } from '@shared/lib/types/agent'

/** The receipt, catalog entry and owner commit together. A competing insert rolls back all three. */
export async function reserveAgentCreation(userId: string, requestId: string, input: CreateAgentInput, withOwner: boolean) {
  const key = agentCreationReceiptKey(userId, requestId)
  const existing = await readRecord(key, agentCreationReceiptSchema)
  if (existing) return { key, ...existing }

  const slug = await agentCatalog.mint()
  try {
    await agentCatalog.insert({ ...input, slug, createdAt: new Date() }, { receiptKey: key, ownerId: withOwner ? userId : undefined })
    return { key, revision: 1, value: { slug, ready: false } }
  } catch (error) {
    const winner = await readRecord(key, agentCreationReceiptSchema)
    if (!winner) throw error
    return { key, ...winner }
  }
}

/** Only the first caller to finish the workspace reports a new creation. */
export async function completeAgentCreation(receipt: Awaited<ReturnType<typeof reserveAgentCreation>>) {
  return compareAndSetRecord(receipt.key, receipt.revision,
    serializeRecordValue(receipt.key, { ...receipt.value, ready: true }, agentCreationReceiptSchema))
}
