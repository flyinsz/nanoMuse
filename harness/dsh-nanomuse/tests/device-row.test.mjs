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

import { faceLabel, focusedFace, isThisDevice, muses, newestAskFrom, newsIds, pickable, tapIntent } from '../src/client/device-row.ts'

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
  assert.deepEqual(tapIntent(me, []), { kind: 'main' })
})

test('picking another device addresses the composer to it', () => {
  const row = muses([device({ id: 'me' }), device({ id: 'p1' })], 'me')
  const other = row.find((f) => !f.isThis)
  assert.deepEqual(tapIntent(other, []), { kind: 'address', deviceId: 'p1' })
})

test('a device waiting on a question leads to that question, not to the composer', () => {
  const row = muses([device({ id: 'me' }), device({ id: 'p1' })], 'me')
  const other = row.find((f) => !f.isThis)
  assert.deepEqual(tapIntent(other, [ask()]), { kind: 'ask', deviceId: 'p1' })
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
