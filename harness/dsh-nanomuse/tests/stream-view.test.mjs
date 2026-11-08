/**
 * Which running turns a chat draws, and when a bubble goes (contract C13, §4).
 *
 * `stream-buckets.test.mjs` covers the merging; this covers the drawing rules `StreamBubbles.ts`
 * follows: one bubble per conversation + round, nothing from this computer, nothing empty, and a
 * finished round's bubble outliving its final text only briefly. The cases are the ones a person
 * would notice: a second run in the same chat overwriting the first, a bubble under a reply that
 * already landed, a line still spinning after the device that ran it went away.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { hasSomethingToDraw, streamBubbles, streamKeyOf, toolLine } from '../src/client/stream-view.ts'

const stream = (over = {}) => ({
  cid: 'c1', session: 's1', round: 'r1', from: 'desk', deviceName: 'Desk',
  text: 'Hello', reasoning: '', tools: [], seq: 1, done: false, at: 100_000, ...over,
})

const tool = (over = {}) => ({ name: 'read_file', stage: 'call', summary: '', ok: true, ...over })

test('a running round of this chat is drawn, oldest first', () => {
  const streams = [stream({ round: 'r2', at: 200 }), stream({ round: 'r1', at: 100 })]
  assert.deepEqual(streamBubbles(streams, 's1', { now: 200 }).map((s) => s.round), ['r1', 'r2'])
})

test('another chat\u2019s streams are not drawn here', () => {
  const streams = [stream({ session: 's2' }), stream({ session: 's1', round: 'mine' })]
  assert.deepEqual(streamBubbles(streams, 's1', { now: 100 }).map((s) => s.round), ['mine'])
  assert.deepEqual(streamBubbles(streams, '', { now: 100 }), [])
})

test('two rounds in one chat are two bubbles, so neither hides the other', () => {
  // the web console keyed its streams by conversation and lost one of two; the round is the fix
  const streams = [stream({ round: 'r1', text: 'first', at: 100 }), stream({ round: 'r2', text: 'second', at: 101 })]
  const shown = streamBubbles(streams, 's1', { now: 101 })
  assert.equal(shown.length, 2)
  assert.deepEqual(shown.map((s) => s.text), ['first', 'second'])
})

test('the same round in two chats is two bubbles too', () => {
  const streams = [stream({ cid: 'c1', session: 's1' }), stream({ cid: 'c2', session: 's2' })]
  assert.equal(streamBubbles(streams, 's1', { now: 100 }).length, 1)
  assert.equal(streamBubbles(streams, 's2', { now: 100 }).length, 1)
  assert.notEqual(streamKeyOf('c1', 'r1'), streamKeyOf('c2', 'r1'))
})

test('a round from this computer is not drawn: the relay does not echo the sender', () => {
  const streams = [stream({ from: 'me' }), stream({ from: 'desk', round: 'theirs' })]
  assert.deepEqual(streamBubbles(streams, 's1', { selfId: 'me', now: 100 }).map((s) => s.round), ['theirs'])
})

test('a round with nothing in it yet draws no bubble', () => {
  // a lone done for a round whose opening batch was lost: it closes the line, it does not open one
  const streams = [stream({ text: '', done: true }), stream({ round: 'r2', text: '' })]
  assert.deepEqual(streamBubbles(streams, 's1', { now: 100 }), [])
  assert.equal(hasSomethingToDraw(stream({ text: '', reasoning: 'why' })), true)
  assert.equal(hasSomethingToDraw(stream({ text: '', tools: [tool()] })), true)
  assert.equal(hasSomethingToDraw(stream({ text: '   ' })), false)
})

test('a round with no round id is left out: it could not be told from another', () => {
  assert.deepEqual(streamBubbles([stream({ round: '' })], 's1', { now: 100 }), [])
})

test('a finished round keeps its bubble only while its final text lands', () => {
  const done = stream({ text: 'the end', done: true, at: 100_000 })
  assert.equal(streamBubbles([done], 's1', { now: 100_000, graceMs: 5000 }).length, 1)
  assert.equal(streamBubbles([done], 's1', { now: 104_000, graceMs: 5000 }).length, 1)
  assert.equal(streamBubbles([done], 's1', { now: 106_000, graceMs: 5000 }).length, 0, 'the synced reply stands alone')
})

test('a round that went quiet ages out, so a line cannot outlive its run', () => {
  const running = stream({ at: 1_000 })
  assert.equal(streamBubbles([running], 's1', { now: 2_000, quietMs: 5_000 }).length, 1)
  assert.equal(streamBubbles([running], 's1', { now: 7_000, quietMs: 5_000 }).length, 0)
  // and the quiet bound is the longer of the two: a running round is not ended by the grace
  assert.equal(streamBubbles([running], 's1', { now: 6_000, graceMs: 100, quietMs: 5_000 }).length, 0)
})

test('no streams at all is no bubbles, not a crash', () => {
  assert.deepEqual(streamBubbles(undefined, 's1'), [])
  assert.deepEqual(streamBubbles([], 's1'), [])
})

test('a step reads as the tool and what it found; a bare call is just its name', () => {
  assert.equal(toolLine(tool({ name: 'read_file' })), 'read_file')
  assert.equal(toolLine(tool({ name: 'read_file', stage: 'result', summary: '12 lines' })), 'read_file \u00b7 12 lines')
  assert.equal(toolLine(tool({ name: 'grep', summary: '   ' })), 'grep')
})
