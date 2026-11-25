import { HandoverTopicTakenError, topicKey, type Handover, type HandoverEntry, type HandoverStore } from './store'

const newestFirst = (a: HandoverEntry, b: HandoverEntry) =>
  b.entryOn.localeCompare(a.entryOn) || b.updatedAt.getTime() - a.updatedAt.getTime() || b.id.localeCompare(a.id)

/** An in-memory HandoverStore (specs). */
export function memoryHandoverStore(): HandoverStore & { handovers: Map<string, Handover>; entries: Map<string, HandoverEntry> } {
  const handovers = new Map<string, Handover>()
  const entries = new Map<string, HandoverEntry>()
  const taken = (handoverId: string, topic: string, except?: string) =>
    [...entries.values()].some((e) => e.handoverId === handoverId && e.id !== except && topicKey(e.topic) === topicKey(topic))
  return {
    handovers,
    entries,
    async insertHandover(h) {
      handovers.set(h.id, { ...h })
    },
    async getHandover(id) {
      const h = handovers.get(id)
      return h ? { ...h } : null
    },
    async listHandovers() {
      return [...handovers.values()]
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || b.id.localeCompare(a.id))
        .map((h) => ({ ...h }))
    },
    async touchHandover(id, at) {
      const h = handovers.get(id)
      if (h) h.updatedAt = at
    },
    async insertEntry(e) {
      if (taken(e.handoverId, e.topic)) throw new HandoverTopicTakenError(e.topic.trim())
      entries.set(e.id, { ...e })
    },
    async getEntry(id) {
      const e = entries.get(id)
      return e ? { ...e } : null
    },
    async entryByTopic(handoverId, topic) {
      const e = [...entries.values()].find((x) => x.handoverId === handoverId && topicKey(x.topic) === topicKey(topic))
      return e ? { ...e } : null
    },
    async listEntries(ids) {
      const set = new Set(ids)
      return [...entries.values()].filter((e) => set.has(e.handoverId)).sort(newestFirst).map((e) => ({ ...e }))
    },
    async updateEntry(id, patch) {
      const e = entries.get(id)
      if (!e) return null
      if (patch.topic !== undefined && taken(e.handoverId, patch.topic, id)) throw new HandoverTopicTakenError(patch.topic.trim())
      const next = { ...e, ...patch }
      entries.set(id, next)
      return { ...next }
    },
    async deleteEntry(id) {
      return entries.delete(id)
    },
  }
}
