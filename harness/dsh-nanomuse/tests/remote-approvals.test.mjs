// The questions raised by work sent to another device: put on this computer's cards, answered
// through the same route, and settled when the target answers it itself. The third case is
// the one that matters: a card closed elsewhere must not send `approve` back, or a *Deny*
// here would overrule an answer the other device already gave itself.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RemoteApprovals } from '../lib/remote-approvals.js'

const q = (over = {}) => ({ approvalId: 'ap-1', device: 'Mac mini', preview: 'Delete ~/build', reason: 'the agent asked', risk: 'moderate', ...over })

test('a card goes up, the person allows it, and the caller is told yes', async () => {
  let changes = 0
  const desk = new RemoteApprovals(() => changes++)
  const wait = desk.ask(q())
  assert.equal(desk.list().length, 1)
  assert.equal(changes, 1)
  const row = desk.list()[0]
  assert.equal(row.summary, 'Delete ~/build')
  assert.equal(row.toolName, 'delegate')
  // no app of this computer stands behind it, so the card must not offer a standing answer
  assert.equal(row.app, '')
  assert.equal(desk.holds(row.id), true)
  assert.equal(desk.decide(row.id, true), true)
  assert.equal(await wait, true)
  assert.equal(desk.list().length, 0)
  // answered already
  assert.equal(desk.decide(row.id, true), false)
})

test('a deny comes back as no', async () => {
  const desk = new RemoteApprovals(() => undefined)
  const wait = desk.ask(q())
  const id = desk.list()[0].id
  desk.decide(id, false)
  assert.equal(await wait, false)
})

test('answered on the target: the card goes and nothing is sent back', async () => {
  const desk = new RemoteApprovals(() => undefined)
  const wait = desk.ask(q())
  const id = desk.list()[0].id
  desk.forget(id)
  // null, not false: an `approve {allow:false}` here would deny a step the target already allowed
  assert.equal(await wait, null)
  assert.equal(desk.list().length, 0)
  // forgetting one already gone is a no-op
  desk.forget(id)
})

test('the run ends with a card still up: it comes down and nothing is sent back', async () => {
  const desk = new RemoteApprovals(() => undefined)
  const a = desk.ask(q({ approvalId: 'ap-a' }))
  const b = desk.ask(q({ approvalId: 'ap-b' }))
  desk.releaseDevice('Mac mini')
  assert.deepEqual(await Promise.all([a, b]), [null, null])
  assert.equal(desk.list().length, 0)
})

test("another device's question is left alone by this one's teardown", async () => {
  const desk = new RemoteApprovals(() => undefined)
  const mine = desk.ask(q({ device: 'Mac mini' }))
  const theirs = desk.ask(q({ device: 'Pixel 8' }))
  desk.releaseDevice('Mac mini')
  assert.equal(await mine, null)
  assert.equal(desk.list().length, 1)
  assert.equal(desk.list()[0].sessionId, 'remote:Pixel 8')
  desk.releaseDevice('Pixel 8')
  assert.equal(await theirs, null)
})

test('two questions at once are told apart', async () => {
  const desk = new RemoteApprovals(() => undefined)
  const first = desk.ask(q({ approvalId: 'ap-a', preview: 'First' }))
  const second = desk.ask(q({ approvalId: 'ap-b', preview: 'Second' }))
  const ids = desk.list().map((r) => r.id)
  assert.equal(ids.length, 2)
  desk.decide(ids[0], false)
  desk.decide(ids[1], true)
  assert.deepEqual(await Promise.all([first, second]), [false, true])
})
