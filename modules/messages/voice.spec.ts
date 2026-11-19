import { describe, expect, it } from 'vitest'
import {
  createChannel,
  deleteMessage,
  listMessages,
  MAX_VOICE_CLIP_MS,
  openDm,
  postMessage,
  readVoiceClip,
  uploadAttachments,
} from './service'
import { depthFixture } from './test-fixtures'

/**
 * Voice messages keep their recording (Contribute: "Sprachnachrichten … wirklich als
 * Sprachnachricht abspielen"): the dictated clip is uploaded into the conversation's Drive
 * folder like any attachment, posted as the message's voice clip next to its transcript, and
 * its bytes are served to the conversation's members only.
 */

const clipBytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4])
const clip = { name: 'Voice message.webm', mime: 'audio/webm;codecs=opus', bytes: clipBytes }
const md = { name: 'notes.md', mime: 'text/markdown', bytes: new TextEncoder().encode('# hi') }

describe('voice messages keep their recording', () => {
  it('a dictated message carries its recording (not as a file chip) next to the transcript, at full quality', async () => {
    const { deps } = depthFixture()
    const ch = await createChannel(deps, 'owner', { name: 'general', private: false })
    const { uploaded } = await uploadAttachments(deps, 'bea', ch.id, [clip, md])
    const [voice, notes] = uploaded
    const { message } = await postMessage(deps, 'bea', ch.id, 'Treffen wir uns um drei?', {
      attachmentIds: [notes.fileId],
      voiceClips: [{ fileId: voice.fileId, durationMs: 4200 }],
    })
    expect(message.body).toBe('Treffen wir uns um drei?')
    expect(message.voice).toEqual([{ fileId: voice.fileId, mime: 'audio/webm;codecs=opus', size: clipBytes.byteLength, durationMs: 4200 }])
    expect(message.attachments.map((a) => a.name)).toEqual(['notes.md'])
    // what everyone else loads later is the same
    const [listed] = (await listMessages(deps, 'carl', ch.id)).messages
    expect(listed.voice).toEqual(message.voice)
    // the bytes are the recorder's own, unchanged
    expect(await readVoiceClip(deps, 'carl', message.id, voice.fileId)).toEqual({ mime: 'audio/webm;codecs=opus', bytes: clipBytes })
  })

  it('a recording alone (the transcript cleared) is still a message', async () => {
    const { deps } = depthFixture()
    const ch = await createChannel(deps, 'owner', { name: 'general', private: false })
    const { uploaded } = await uploadAttachments(deps, 'bea', ch.id, [clip])
    const { message } = await postMessage(deps, 'bea', ch.id, '  ', { voiceClips: [{ fileId: uploaded[0].fileId, durationMs: 900 }] })
    expect(message.body).toBe('')
    expect(message.voice).toHaveLength(1)
  })

  it('messages without a kept recording (dictated before, or typed) have no voice clip', async () => {
    const { deps } = depthFixture()
    const ch = await createChannel(deps, 'owner', { name: 'general', private: false })
    const { message } = await postMessage(deps, 'bea', ch.id, 'a transcript whose audio was never kept')
    expect(message.voice).toEqual([])
    expect(message.body).toBe('a transcript whose audio was never kept')
  })

  it('serves a private channel’s recording to its members only; outsiders get "not found"', async () => {
    const { deps } = depthFixture()
    const ch = await createChannel(deps, 'bea', { name: 'lead', private: true, userIds: ['owner'] })
    const { uploaded } = await uploadAttachments(deps, 'bea', ch.id, [clip])
    const { message } = await postMessage(deps, 'bea', ch.id, 'hi', { voiceClips: [{ fileId: uploaded[0].fileId, durationMs: 1000 }] })
    await expect(readVoiceClip(deps, 'owner', message.id, uploaded[0].fileId)).resolves.toMatchObject({ bytes: clipBytes })
    await expect(readVoiceClip(deps, 'carl', message.id, uploaded[0].fileId)).rejects.toMatchObject({ code: 'not_found' })
    await expect(readVoiceClip(deps, 'nobody', message.id, uploaded[0].fileId)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('a DM’s recording is for the DM’s members only', async () => {
    const { deps } = depthFixture()
    const dm = await openDm(deps, 'bea', ['carl'])
    const { uploaded } = await uploadAttachments(deps, 'bea', dm.id, [clip])
    const { message } = await postMessage(deps, 'bea', dm.id, 'psst', { voiceClips: [{ fileId: uploaded[0].fileId, durationMs: 1000 }] })
    await expect(readVoiceClip(deps, 'carl', message.id, uploaded[0].fileId)).resolves.toMatchObject({ bytes: clipBytes })
    await expect(readVoiceClip(deps, 'owner', message.id, uploaded[0].fileId)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('serves only a recording of that very message: not an ordinary file, not another message’s, not a deleted message’s', async () => {
    const { deps } = depthFixture()
    const ch = await createChannel(deps, 'owner', { name: 'general', private: false })
    const { uploaded } = await uploadAttachments(deps, 'bea', ch.id, [clip, md])
    const [voice, notes] = uploaded
    const { message } = await postMessage(deps, 'bea', ch.id, 'hi', { attachmentIds: [notes.fileId], voiceClips: [{ fileId: voice.fileId, durationMs: 1000 }] })
    const { message: other } = await postMessage(deps, 'carl', ch.id, 'other')
    await expect(readVoiceClip(deps, 'carl', message.id, notes.fileId)).rejects.toMatchObject({ code: 'not_found' })
    await expect(readVoiceClip(deps, 'carl', other.id, voice.fileId)).rejects.toMatchObject({ code: 'not_found' })
    await expect(readVoiceClip(deps, 'carl', 'not-an-id', voice.fileId)).rejects.toMatchObject({ code: 'not_found' })
    await deleteMessage(deps, 'bea', message.id)
    await expect(readVoiceClip(deps, 'carl', message.id, voice.fileId)).rejects.toMatchObject({ code: 'not_found' })
    expect((await listMessages(deps, 'carl', ch.id)).messages.find((m) => m.id === message.id)?.voice).toEqual([])
  })

  it('refuses a voice clip that is not audio, has no sensible length, or was not uploaded here by the author', async () => {
    const { deps } = depthFixture()
    const a = await createChannel(deps, 'owner', { name: 'a', private: false })
    const b = await createChannel(deps, 'owner', { name: 'b', private: false })
    const { uploaded } = await uploadAttachments(deps, 'bea', a.id, [clip, md])
    const [voice, notes] = uploaded
    const post = (actor: string, conversationId: string, fileId: string, durationMs: number) =>
      postMessage(deps, actor, conversationId, 'x', { voiceClips: [{ fileId, durationMs }] })
    await expect(post('bea', a.id, notes.fileId, 1000)).rejects.toMatchObject({ code: 'invalid' })
    await expect(post('bea', a.id, voice.fileId, 0)).rejects.toMatchObject({ code: 'invalid' })
    await expect(post('bea', a.id, voice.fileId, 1.5)).rejects.toMatchObject({ code: 'invalid' })
    await expect(post('bea', a.id, voice.fileId, MAX_VOICE_CLIP_MS + 1)).rejects.toMatchObject({ code: 'invalid' })
    await expect(post('bea', b.id, voice.fileId, 1000)).rejects.toMatchObject({ code: 'invalid' })
    await expect(post('carl', a.id, voice.fileId, 1000)).rejects.toMatchObject({ code: 'invalid' })
    // one file is either an attachment or a recording, never both
    await expect(
      postMessage(deps, 'bea', a.id, 'x', { attachmentIds: [voice.fileId], voiceClips: [{ fileId: voice.fileId, durationMs: 1000 }] }),
    ).rejects.toMatchObject({ code: 'invalid' })
  })
})
