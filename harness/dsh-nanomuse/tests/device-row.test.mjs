/**
 * The row of the account's Muses, on the desktop.
 *
 * The rules are worth checking without a window because they are the ones the person actually
 * reads: which face is large, which wears the dot, and where a tap goes. The phone and the console
 * answer the same questions, so the cases below are the answers this third client must not get
 * wrong — a row that said "this computer" of the wrong device, or put a dot on a device that never
 * asked, would be worse than no row at all.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { boundDeviceFor } from '../src/client/device-mention.ts'
import { busyIds, centringScroll, faceLabel, focusedFace, isThisDevice, muses, newestAskFrom, newsIds, pickable, tapIntent } from '../src/client/device-row.ts'

function device(over = {}) {
  return { id: 'd1', name: 'Mac mini', kind: 'computer', os: 'macOS', version: '1', online: true, last_seen: 0, controllable: true, actions: [], ...over }
}

const ask = (over = {}) => ({ id: 'a1', from: 'Phone', fromId: 'p1', action: 'ask', text: 'Which folder?', at: 1, ...over })

test('this device is the one the hub named, not merely the first', () => {
  assert.equal(isThisDevice(device({ id: 'hub' }), 'hub'), true)
  assert.equal(isThisDevice(device({ id: 'other' }), 'hub'), false)
})

test('a blank hub id matches nothing, so no device is claimed as this one', () => {
  assert.equal(isThisDevice(device({ id: '' }), ''), false)
  assert.equal(isThisDevice(device({ id: 'd1' }), ''), false)
})

test('the row puts this device first, then online by name, then the sleeping', () => {
  const devices = [
    device({ id: 'off', name: 'Old phone', online: false }),
    device({ id: 'zeta', name: 'Zeta', online: true }),
    device({ id: 'mine', name: 'Aardvark', online: false }),
    device({ id: 'alpha', name: 'Alpha', online: true }),
  ]
  assert.deepEqual(muses(devices, 'mine').map((f) => f.device.id), ['mine', 'alpha', 'zeta', 'off'])
})

test('the row leaves out browser tabs and nameless entries', () => {
  const devices = [device({ id: 'tab', kind: 'web' }), device({ id: 'blank', name: '  ' }), device({ id: 'ok' })]
  assert.deepEqual(muses(devices, '').map((f) => f.device.id), ['ok'])
})

test('the order does not depend on which chat is open', () => {
  // the strip only looks like it rolls if a pick does not move the faces around. This device is
  // first either way; the others keep the same order whatever chat is open (there is no second
  // argument here, because this client's chat is never aimed at another device).
  const devices = [device({ id: 'a', name: 'Alpha' }), device({ id: 'b', name: 'Beta' })]
  const row = muses(devices, '')
  assert.deepEqual(row.map((f) => f.device.id), ['a', 'b'])
  assert.deepEqual(muses([...devices].reverse(), '').map((f) => f.device.id), ['a', 'b'])
})

test('the large face is this computer', () => {
  const row = muses([device({ id: 'a' }), device({ id: 'me' })], 'me')
  assert.equal(focusedFace(row)?.device.id, 'me')
})

test('with the hub silent the first face is large rather than none', () => {
  const row = muses([device({ id: 'a', name: 'Alpha' }), device({ id: 'b', name: 'Beta' })], '')
  assert.equal(focusedFace(row)?.device.id, 'a')
})

test('no devices at all means no large face', () => {
  assert.equal(focusedFace([]), null)
})

test('a device that asked here wears the dot', () => {
  const row = muses([device({ id: 'p1' }), device({ id: 'me' })], 'me')
  assert.deepEqual([...newsIds([ask()], row)], ['p1'])
})

test('two questions from one device are one dot', () => {
  const row = muses([device({ id: 'p1' }), device({ id: 'me' })], 'me')
  assert.deepEqual([...newsIds([ask({ id: 'a' }), ask({ id: 'b' })], row)], ['p1'])
})

test('an ask from a device not in the row puts no dot on anything', () => {
  // a device the account no longer lists cannot be shown, so there is no face to mark
  const row = muses([device({ id: 'me' })], 'me')
  assert.equal(newsIds([ask({ fromId: 'gone' })], row).size, 0)
})

test('no asks means no dots', () => {
  const row = muses([device({ id: 'p1' }), device({ id: 'me' })], 'me')
  assert.equal(newsIds([], row).size, 0)
})

test('picking this computer goes home', () => {
  const row = muses([device({ id: 'me' }), device({ id: 'p1' })], 'me')
  const me = row.find((f) => f.isThis)
  assert.deepEqual(tapIntent(me, []), { kind: 'main', chat: null })
})

test('going home names the chat to show, when the shell knows it', () => {
  // "A chat of its own" is a particular session, so the tap carries it. `mainChat` is the same
  // session the calls column treats as the main chat (the host's own, then the remembered one).
  const row = muses([device({ id: 'me' }), device({ id: 'p1' })], 'me')
  const me = row.find((f) => f.isThis)
  assert.deepEqual(tapIntent(me, [], 'session-main'), { kind: 'main', chat: 'session-main' })
})

test('picking another device opens that device\u2019s own chat', () => {
  const row = muses([device({ id: 'me' }), device({ id: 'p1', name: 'Pixel' })], 'me')
  const other = row.find((f) => !f.isThis)
  assert.deepEqual(tapIntent(other, []), { kind: 'chat', deviceId: 'p1', name: 'Pixel', chat: null })
})

test('a device that already has a chat leads back to the one it has', () => {
  const row = muses([device({ id: 'me' }), device({ id: 'p1', name: 'Pixel' })], 'me', {
    chatFor: (id) => (id === 'p1' ? 'session-7' : null),
  })
  const other = row.find((f) => !f.isThis)
  assert.deepEqual(tapIntent(other, []), { kind: 'chat', deviceId: 'p1', name: 'Pixel', chat: 'session-7' })
})

test('a device waiting on a question leads to that question, not to its chat', () => {
  const row = muses([device({ id: 'me' }), device({ id: 'p1' })], 'me')
  const other = row.find((f) => !f.isThis)
  assert.deepEqual(tapIntent(other, [ask()]), { kind: 'ask', deviceId: 'p1' })
})

test('a question does not divert this computer\u2019s own face from going home', () => {
  const row = muses([device({ id: 'me' }), device({ id: 'p1' })], 'me')
  const me = row.find((f) => f.isThis)
  assert.deepEqual(tapIntent(me, [ask({ fromId: 'me' })], 'session-main'), { kind: 'main', chat: 'session-main' })
})

test('the newest question from a device is the one a dotted tap opens', () => {
  const asks = [ask({ id: 'old', fromId: 'p1', at: 1 }), ask({ id: 'new', fromId: 'p1', at: 9 })]
  assert.equal(newestAskFrom('p1', asks).id, 'new')
})

test('a device with no question is not waiting on one', () => {
  assert.equal(newestAskFrom('p1', [ask({ fromId: 'p2' })]), null)
  assert.equal(newestAskFrom('p1', []), null)
})

test('this computer wears its own name rather than the account name every device shares', () => {
  const row = muses([device({ id: 'me', name: 'nanoMuse' })], 'me')
  assert.equal(faceLabel(row[0], 'This computer'), 'This computer')
})

test('another device wears the name the account knows it by', () => {
  const row = muses([device({ id: 'p1', name: 'Pixel 8' })], '')
  assert.equal(faceLabel(row[0], 'This computer'), 'Pixel 8')
})

test('a sleeping device is drawn but cannot be picked', () => {
  const row = muses([device({ id: 'off', online: false })], '')
  assert.equal(pickable(row[0]), false)
  assert.equal(pickable(muses([device({ id: 'on', online: true })], '')[0]), true)
})

// ---- the disc in the middle ------------------------------------------------------------

test('the disc of the chat on screen is the large one', () => {
  const devices = [device({ id: 'me' }), device({ id: 'p1' }), device({ id: 'p2' })]
  const row = muses(devices, 'me', { chatFor: (id) => (id === 'p2' ? 'session-2' : null) })
  assert.equal(focusedFace(row, 'session-2')?.device.id, 'p2')
})

test('a chat that belongs to no device leaves this computer large', () => {
  const devices = [device({ id: 'me' }), device({ id: 'p1' })]
  const row = muses(devices, 'me', { chatFor: () => null })
  assert.equal(focusedFace(row, 'some-side-chat')?.device.id, 'me')
})

test('with nothing open this computer is the large one', () => {
  const row = muses([device({ id: 'a' }), device({ id: 'me' })], 'me')
  assert.equal(focusedFace(row, null)?.device.id, 'me')
})

// ---- the roll -------------------------------------------------------------------------

test('centring puts a disc in the middle of the box', () => {
  // a 200-wide box holding 1000 of content, scrolled nowhere, a 40-wide disc at content 500
  const left = centringScroll({ boxLeft: 0, boxWidth: 200, faceLeft: 500, faceWidth: 40, scrollLeft: 0, contentWidth: 1000 })
  assert.equal(left, 500 - (200 - 40) / 2)
})

test('the roll never asks for less than the start or more than the end', () => {
  const atStart = centringScroll({ boxLeft: 0, boxWidth: 200, faceLeft: 0, faceWidth: 40, scrollLeft: 0, contentWidth: 1000 })
  assert.equal(atStart, 0)
  const atEnd = centringScroll({ boxLeft: 0, boxWidth: 200, faceLeft: 980, faceWidth: 40, scrollLeft: 0, contentWidth: 1000 })
  assert.equal(atEnd, 800)
})

test('the roll accounts for where the box is already scrolled to', () => {
  // The same disc as the first test (its own place in the content is 500), with the box scrolled
  // 300: on screen it now sits at faceLeft -100. The scroll is taken back out to find that place
  // again, so the answer must come out the same: 420, not the 720 a naive reading would give.
  const left = centringScroll({ boxLeft: -300, boxWidth: 200, faceLeft: -100, faceWidth: 40, scrollLeft: 300, contentWidth: 1000 })
  assert.equal(left, 420)
})

// ---- which chat is on screen ------------------------------------------------------------

test('a device chat opened elsewhere leaves that device large, from the chat id alone', () => {
  // What the dock's own session seat hands down: the id of the chat on screen. It is matched
  // against each device's chat, so the row follows a chat opened from anywhere in the app.
  const devices = [device({ id: 'me' }), device({ id: 'p1' }), device({ id: 'p2' })]
  const row = muses(devices, 'me', { chatFor: (id) => (id === 'p2' ? 'session-2' : null) })
  assert.equal(focusedFace(row, 'session-2')?.device.id, 'p2')
})

test('the chat on screen wins over this computer even when the store has nothing', () => {
  // The window store is written by a different seat and can still be null on the frame a chat
  // opens (measured: the seat had the right id while the store was empty). The row must not fall
  // back to this computer while a chat with a device is what is actually on screen.
  const devices = [device({ id: 'me' }), device({ id: 'p1' })]
  const row = muses(devices, 'me', { chatFor: (id) => (id === 'p1' ? 'session-1' : null) })
  assert.equal(focusedFace(row, 'session-1')?.device.id, 'p1')
  assert.equal(focusedFace(row, null)?.device.id, 'me')
})

test('the order the roll moves over does not change when a device chat opens', () => {
  // The roll needs the row to stay put: an order that answered "whose chat is open" would put
  // the picked disc in the same slot every time and the window would never have to move.
  const devices = [device({ id: 'me', name: 'Z' }), device({ id: 'a', name: 'Alpha' }), device({ id: 'b', name: 'Beta' })]
  const before = muses(devices, 'me').map((f) => f.device.id)
  const after = muses(devices, 'me', { chatFor: (id) => (id === 'b' ? 'session-b' : null) }).map((f) => f.device.id)
  assert.deepEqual(before, after)
})

// ── the spinner: a task sent and not yet answered ──────────────────────────────────
test('a task in flight puts the spinner on the disc it went to', () => {
  const row = muses([device({ id: 'me' }), device({ id: 'p1' }), device({ id: 'd2' })], 'me')
  assert.deepEqual([...busyIds({ phase: 'asking', deviceId: 'p1' }, row)], ['p1'])
})

test('an answered or failed task leaves the row quiet', () => {
  const row = muses([device({ id: 'me' }), device({ id: 'p1' })], 'me')
  assert.equal(busyIds({ phase: 'answered', deviceId: 'p1' }, row).size, 0)
  assert.equal(busyIds({ phase: 'failed', deviceId: 'p1' }, row).size, 0)
  assert.equal(busyIds({ phase: 'idle', deviceId: 'p1' }, row).size, 0)
})

test('no task, or a task with no device, puts a spinner nowhere', () => {
  const row = muses([device({ id: 'me' }), device({ id: 'p1' })], 'me')
  assert.equal(busyIds(null, row).size, 0)
  assert.equal(busyIds(undefined, row).size, 0)
  assert.equal(busyIds({ phase: 'asking', deviceId: '' }, row).size, 0)
})

test('a spinner is never drawn on a disc the row does not have', () => {
  const row = muses([device({ id: 'me' }), device({ id: 'p1' })], 'me')
  assert.equal(busyIds({ phase: 'asking', deviceId: 'signed-out' }, row).size, 0)
})

// ── a device's own chat sends its words to that device, with no @name ───────────
test('the chat on screen names the device a message belongs to', () => {
  const devices = [device({ id: 'me' }), device({ id: 'p1', name: 'Mac mini' })]
  assert.deepEqual(boundDeviceFor('session-1', { p1: 'session-1' }, devices), { id: 'p1', name: 'Mac mini' })
})

test('the main chat and an unknown chat belong to no device', () => {
  const devices = [device({ id: 'me' }), device({ id: 'p1' })]
  assert.equal(boundDeviceFor('main', { p1: 'session-1' }, devices), null)
  assert.equal(boundDeviceFor(null, { p1: 'session-1' }, devices), null)
  assert.equal(boundDeviceFor('session-1', undefined, devices), null)
})

test('a device that went offline or lost its name is not a target', () => {
  const devices = [device({ id: 'p1', name: 'Mac mini', online: false }), device({ id: 'p2', name: '  ' })]
  assert.equal(boundDeviceFor('session-1', { p1: 'session-1' }, devices), null)
  assert.equal(boundDeviceFor('session-2', { p2: 'session-2' }, devices), null)
})

test('two device chats stay separate', () => {
  const devices = [device({ id: 'p1', name: 'A' }), device({ id: 'p2', name: 'B' })]
  const chats = { p1: 'session-1', p2: 'session-2' }
  assert.equal(boundDeviceFor('session-2', chats, devices)?.id, 'p2')
  assert.equal(boundDeviceFor('session-1', chats, devices)?.id, 'p1')
})
