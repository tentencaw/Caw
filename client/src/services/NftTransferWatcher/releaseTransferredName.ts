import { prisma } from '../../prismaClient'
import groupService from '../DmService/groupService'

/**
 * Block timestamps by block number, so several transfers in one block read it
 * once. Blocks don't change once read; the map is capped to stay small.
 */
const blockTimes = new Map<number, Date>()

export async function transferTime(
  provider: { getBlock(blockNumber: number): Promise<{ timestamp: number } | null> },
  blockNumber: number,
): Promise<Date> {
  const hit = blockTimes.get(blockNumber)
  if (hit) return hit
  const block = await provider.getBlock(blockNumber)
  if (!block) throw new Error(`block ${blockNumber} not found`)
  const at = new Date(block.timestamp * 1000)
  if (blockTimes.size >= 1024) blockTimes.clear()
  blockTimes.set(blockNumber, at)
  return at
}

/**
 * A name's moderator role and its group memberships were granted to whoever
 * held the name at the time, not to whoever holds it next. For a transfer at
 * `at`:
 *
 * - a role other than USER is dropped if it was last set (`set_role` in
 *   ModeratorAction) before `at`, or was never logged; the drop is logged as
 *   `transfer_role_reset`;
 * - every group joined before `at` is left through leaveGroup, so ownership
 *   passes on and the group gets its usual system messages.
 *
 * The block time is read only when there is something to release.
 *
 * Comparing with the transfer's block time, instead of acting on every event,
 * keeps a replayed or retried event from touching what a later owner was given
 * (a role set, or a re-invite, after that transfer). 1:1 conversations are left
 * alone: a name's DMs go with the name. Throws on failure so the watcher holds
 * its checkpoint and retries; a group already left and a role already reset
 * make the retry a no-op.
 */
export async function releaseTransferredName(tokenId: number, transferAt: () => Promise<Date>): Promise<void> {
  const user = await prisma.user.findUnique({ where: { tokenId }, select: { role: true } })
  const memberships = await prisma.conversationParticipant.findMany({
    where: { userId: tokenId, leftAt: null, conversation: { is: { type: 'GROUP' } } },
    select: { conversationId: true, joinedAt: true },
  })
  // Nothing to release: skip the block read, so a replay of history only
  // costs an RPC for names that hold a role or are in a group.
  if ((!user || user.role === 'USER') && memberships.length === 0) return
  const at = await transferAt()

  if (user && user.role !== 'USER') {
    const lastSet = await prisma.moderatorAction.findFirst({
      where: { type: 'set_role', targetUserId: tokenId },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    })
    if (!lastSet || lastSet.createdAt < at) {
      const from = user.role
      await prisma.$transaction(async tx => {
        await tx.user.update({ where: { tokenId }, data: { role: 'USER' } })
        await tx.moderatorAction.create({
          data: {
            actorTokenId: null,
            type: 'transfer_role_reset',
            targetUserId: tokenId,
            reason: `${from} → USER: name changed hands`,
          },
        })
      })
      console.warn(`[NftTransferWatcher] tokenId=${tokenId}: ${from} role dropped — ${lastSet ? 'it was set before the transfer' : 'no set_role record'}`)
    }
  }

  const groups = memberships.filter(m => m.joinedAt < at)
  for (const g of groups) {
    await groupService.leaveGroup({ conversationId: g.conversationId, actorUserId: tokenId })
  }
  if (groups.length > 0) {
    console.warn(`[NftTransferWatcher] tokenId=${tokenId}: left ${groups.length} group(s) joined before the transfer`)
  }
}
