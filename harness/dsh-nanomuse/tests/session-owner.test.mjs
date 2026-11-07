/**
 * Which device runs a conversation, and where one sentence goes (contract C13, §2).
 *
 * The routing is the part of C13 a person feels: send a sentence in the wrong place and the work
 * happens on a machine they are not looking at, using a memory that is not the one they meant.
 * The cases below are the answers the design fixes: `@` beats the owner, the owner sticks after a
 * mention moved it, a synced-in turn never moves it, and `@本机` comes home and stays home.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { executorOf, executorVisible, otherDevices, routeMessage, selfMention, thisNames, trimOwners } from '../src/client/session-owner.ts'

function device(over = {}) {
  return { id: 'd1', name: 'Mac mini', kind: 'computer', os: 'macOS', version: '1', online: true, last_seen: 0, controllable: true, actions: [], ...over }
}

const SELF = 'this-mac'
const SELF_NAME = 'nanoMuse'
const LABEL = 'This computer'

const world = (devices, over = {}) => ({
  selfName: SELF_NAME,
  thisLabel: LABEL,
  selfId: SELF,
  devices: [device({ id: SELF, name: SELF_NAME }), ...devices],
  owner: undefined,
  bound: null,
  ...over,
})

const desk = device({ id: 'desk', name: 'Desk' })

test('a sentence with no owner and no mention runs here', () => {
  const route = routeMessage(world([desk], { text: 'tidy the downloads folder' }))
  assert.deepEqual(route.target, { kind: 'local' })
  assert.equal(route.text, 'tidy the downloads folder')
  assert.equal(route.owner, undefined)
})

test('the owner runs a plain sentence, and stays the owner', () => {
  const route = routeMessage(world([desk], { text: 'run the tests', owner: 'desk' }))
  assert.deepEqual(route.target, { kind: 'device', id: 'desk', name: 'Desk', online: true })
  assert.equal(route.text, 'run the tests')
  assert.equal(route.owner, undefined, 'a plain sentence leaves the record alone')
})

test('an @ moves the owner to that device and takes the mention off the text', () => {
  const route = routeMessage(world([desk], { text: '@Desk build it' }))
  assert.deepEqual(route.target, { kind: 'device', id: 'desk', name: 'Desk', online: true })
  assert.equal(route.text, 'build it')
  assert.equal(route.owner, 'desk')
})

test('@ beats the owner: naming another device goes there, whatever the owner is', () => {
  const pixel = device({ id: 'p8', name: 'Pixel 8' })
  const route = routeMessage(world([desk, pixel], { text: '@Pixel 8 take a photo', owner: 'desk' }))
  assert.deepEqual(route.target, { kind: 'device', id: 'p8', name: 'Pixel 8', online: true })
  assert.equal(route.owner, 'p8')
})

test('the owner sticks across sentences: @Desk, then two plain ones, all go to Desk', () => {
  const first = routeMessage(world([desk], { text: '@Desk build it' }))
  assert.equal(first.owner, 'desk')
  // the record the first sentence wrote is what the next two read
  for (const text of ['now run the tests', 'and zip the output']) {
    const route = routeMessage(world([desk], { text, owner: first.owner }))
    assert.deepEqual(route.target, { kind: 'device', id: 'desk', name: 'Desk', online: true }, text)
    assert.equal(route.owner, undefined, text)
  }
})

test('a turn synced in from another device does not move the owner', () => {
  // the design's point: the owner is what the person set, not where the last turn came from. The
  // routing is handed only the record, so a synced line cannot reach it at all — this is the
  // guard that it stays that way: with the owner recorded as Desk, a plain sentence still goes.
  const route = routeMessage(world([desk], { text: 'what did it say?', owner: 'desk' }))
  assert.deepEqual(route.target, { kind: 'device', id: 'desk', name: 'Desk', online: true })
})

// ---- @本机 -----------------------------------------------------------------------------

test('@本机 runs here and comes home', () => {
  const route = routeMessage(world([desk], { text: '@本机 open the folder', owner: 'desk' }))
  assert.deepEqual(route.target, { kind: 'local' })
  assert.equal(route.text, 'open the folder')
  assert.equal(route.owner, '', 'home is recorded, not left unset')
})

test('this computer\u2019s own account name is a way home too', () => {
  const route = routeMessage(world([desk], { text: `@${SELF_NAME} read the log`, owner: 'desk' }))
  assert.deepEqual(route.target, { kind: 'local' })
  assert.equal(route.text, 'read the log')
  assert.equal(route.owner, '')
})

test('the word the row uses for this computer is a way home', () => {
  const route = routeMessage(world([desk], { text: '@This computer read the log', owner: 'desk' }))
  assert.deepEqual(route.target, { kind: 'local' })
  assert.equal(route.owner, '')
})

test('home sticks: @本机 then a plain sentence does not spring back to Desk', () => {
  const home = routeMessage(world([desk], { text: '@本机 open the folder', owner: 'desk' }))
  assert.equal(home.owner, '')
  const next = routeMessage(world([desk], { text: 'and save it', owner: home.owner }))
  assert.deepEqual(next.target, { kind: 'local' })
  assert.equal(next.owner, undefined)
})

test('@本机 with nothing after it is not a task, so it stays an ordinary message', () => {
  // an empty task is not a task, the same reading `device-mention.ts` and `mention.py` take
  const route = routeMessage(world([desk], { text: '@本机', owner: 'desk' }))
  assert.deepEqual(route.target, { kind: 'device', id: 'desk', name: 'Desk', online: true })
  assert.equal(route.text, '@本机')
})

test('this computer is never a target of its own mention without the home rule', () => {
  // `@nanoMuse` addressed the machine we are on: that is home, not a frame to ourselves
  const route = routeMessage(world([desk], { text: `@${SELF_NAME} tidy up` }))
  assert.equal(route.target.kind, 'local')
})

test('the names that mean this computer are the literal, the machine and the label, once each', () => {
  assert.deepEqual(thisNames(SELF_NAME, LABEL), ['本机', SELF_NAME, LABEL])
  assert.deepEqual(thisNames('', ''), ['本机'])
  assert.deepEqual(thisNames('  ', ''), ['本机'])
  // a machine already called 本机 is not listed twice
  assert.deepEqual(thisNames('本机', '本机'), ['本机'])
})

test('selfMention is null when the sentence addresses nothing at home', () => {
  assert.equal(selfMention('@Desk build it', thisNames(SELF_NAME, LABEL)), null)
  assert.equal(selfMention('build it', thisNames(SELF_NAME, LABEL)), null)
})

// ---- the chat of a device --------------------------------------------------------------

test('a device\u2019s own chat runs on that device with no mention written', () => {
  const route = routeMessage(world([desk], { text: 'what is on screen?', bound: { id: 'desk', name: 'Desk' } }))
  assert.deepEqual(route.target, { kind: 'device', id: 'desk', name: 'Desk', online: true })
  assert.equal(route.owner, undefined, 'the chat\u2019s own binding is enough; nothing new to record')
})

test('an @ in a device\u2019s own chat wins over the chat\u2019s device', () => {
  const pixel = device({ id: 'p8', name: 'Pixel 8' })
  const route = routeMessage(world([desk, pixel], { text: '@Pixel 8 take a photo', bound: { id: 'desk', name: 'Desk' } }))
  assert.deepEqual(route.target, { kind: 'device', id: 'p8', name: 'Pixel 8', online: true })
  assert.equal(route.owner, 'p8')
})

test('@本机 in a device\u2019s own chat brings that chat home', () => {
  const route = routeMessage(world([desk], { text: '@本机 take over', bound: { id: 'desk', name: 'Desk' } }))
  assert.deepEqual(route.target, { kind: 'local' })
  assert.equal(route.owner, '')
})

// ---- an owner that cannot be reached ---------------------------------------------------

test('an offline owner is still named, with the send\u2019s own refusal in it', () => {
  const sleeping = device({ id: 'desk', name: 'Desk', online: false })
  const route = routeMessage(world([sleeping], { text: 'run it', owner: 'desk' }))
  assert.deepEqual(route.target, { kind: 'device', id: 'desk', name: 'Desk', online: false })
})

test('an owner the account no longer lists falls back to this computer', () => {
  // there is no frame to build for a device that is not on the list, so the sentence stays here
  const route = routeMessage(world([desk], { text: 'run it', owner: 'gone' }))
  assert.deepEqual(route.target, { kind: 'local' })
})

test('an @ that matches no online device is an ordinary message, @ and all', () => {
  const route = routeMessage(world([desk], { text: '@Nobody hello' }))
  assert.deepEqual(route.target, { kind: 'local' })
  assert.equal(route.text, '@Nobody hello')
})

// ---- the resolution the line above the composer reads ----------------------------------

test('executorOf reads the owner, then the chat\u2019s device, then this computer', () => {
  const devices = [device({ id: SELF, name: SELF_NAME }), desk]
  assert.deepEqual(executorOf('desk', null, devices, SELF), { kind: 'device', id: 'desk', name: 'Desk', online: true })
  assert.deepEqual(executorOf(undefined, { id: 'desk', name: 'Desk' }, devices, SELF), { kind: 'device', id: 'desk', name: 'Desk', online: true })
  assert.deepEqual(executorOf(undefined, null, devices, SELF), { kind: 'local' })
})

test('an owner recorded as home wins over the device chat it was opened in', () => {
  const devices = [device({ id: SELF, name: SELF_NAME }), desk]
  assert.deepEqual(executorOf('', { id: 'desk', name: 'Desk' }, devices, SELF), { kind: 'local' })
})

test('an owner that is this computer reads as here, whatever the device list says', () => {
  const devices = [device({ id: SELF, name: SELF_NAME }), desk]
  assert.deepEqual(executorOf(SELF, null, devices, SELF), { kind: 'local' })
})

// ---- when the line is worth drawing ----------------------------------------------------

test('the line is hidden while this computer is the only device', () => {
  const devices = [device({ id: SELF, name: SELF_NAME })]
  assert.equal(executorVisible({ kind: 'local' }, devices, SELF), false)
})

test('the line says who runs it as soon as the account has another device', () => {
  const devices = [device({ id: SELF, name: SELF_NAME }), desk]
  assert.equal(executorVisible({ kind: 'local' }, devices, SELF), true)
  assert.equal(executorVisible({ kind: 'device', id: 'desk', name: 'Desk', online: true }, devices, SELF), true)
})

test('browser tabs and nameless entries are not owners, so they do not bring the line out', () => {
  const devices = [device({ id: SELF, name: SELF_NAME }), device({ id: 'tab', kind: 'web', name: 'Tab' }), device({ id: 'blank', name: '  ' })]
  assert.deepEqual(otherDevices(devices, SELF), [])
  assert.equal(executorVisible({ kind: 'local' }, devices, SELF), false)
})

test('otherDevices leaves out this computer, tabs and nameless entries', () => {
  const devices = [device({ id: SELF, name: SELF_NAME }), desk, device({ id: 'tab', kind: 'web', name: 'Tab' }), device({ id: 'blank', name: '  ' })]
  assert.deepEqual(otherDevices(devices, SELF).map((d) => d.id), ['desk'])
})

// ---- the record's ceiling --------------------------------------------------------------

test('the owner record keeps its newest conversations and drops the oldest', () => {
  const record = { a: 'desk', b: '', c: 'desk', d: 'p8' }
  assert.deepEqual(trimOwners(record, 2), { c: 'desk', d: 'p8' })
  assert.deepEqual(trimOwners(record, 9), record, 'under the ceiling nothing is dropped')
  assert.deepEqual(trimOwners(record, 0), {})
})

test('a home entry is kept like any other, empty string and all', () => {
  // `''` is a decision, not a gap: dropping it would send the chat back to its device
  assert.deepEqual(trimOwners({ a: '', b: 'desk' }, 1), { b: 'desk' })
  assert.deepEqual(trimOwners({ a: '', b: 'desk' }, 2), { a: '', b: 'desk' })
})
