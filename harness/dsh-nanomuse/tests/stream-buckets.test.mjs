/**
 * A turn in progress on another device, bucketed and merged (contract C13, §4).
 *
 * The frame shape is frozen in `docs/tasks/session-handoff-impl.md` §B. What matters here is that
 * two streams in one conversation stay apart (the web console's bug this fixes), that a batch is
 * appended rather than replaced, and that a duplicate or post-`done` frame is dropped instead of
 * doubling the text on screen.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { applyStreamFrame, liveStreams, pruneStreams, readStreamFrame, streamDevice, streamOf, streamsOf } from '../src/client/stream-buckets.ts'

const frame = (over = {}) => ({ cid: 'c1', from: 'desk', round: 'r1', seq: 1, done: false, ...over })

function device(over = {}) {
  return { id: 'desk', name: 'Desk', kind: 'computer', os: 'macOS', version: '1', online: true, last_seen: 0, controllable: true, actions: [], ...over }
}

test('a first frame makes a bucket holding its words', () => {
  const { buckets, round, changed } = applyStreamFrame({}, frame({ delta: 'Hello' }), 100)
  assert.equal(changed, true)
  assert.equal(round, 'r1')
  assert.deepEqual(streamOf(buckets, 'c1', 'r1'), {
    cid: 'c1', round: 'r1', from: 'desk', seq: 1, text: 'Hello', reasoning: '', tools: [], done: false, at: 100,
  })
})

test('a later batch is appended to the text, not written over it', () => {
  const one = applyStreamFrame({}, frame({ delta: 'Hello' }), 100)
  const two = applyStreamFrame(one.buckets, frame({ seq: 2, delta: ' there' }), 200)
  assert.equal(streamOf(two.buckets, 'c1', 'r1').text, 'Hello there')
  // the input was not written to; the first map still says what it said
  assert.equal(streamOf(one.buckets, 'c1', 'r1').text, 'Hello')
})

test('reasoning grows beside the text, in its own field', () => {
  let buckets = applyStreamFrame({}, frame({ delta: 'answer', reasoning: 'why' }), 100).buckets
  buckets = applyStreamFrame(buckets, frame({ seq: 2, reasoning: ' not' }), 200).buckets
  const bucket = streamOf(buckets, 'c1', 'r1')
  assert.equal(bucket.text, 'answer')
  assert.equal(bucket.reasoning, 'why not')
})

test('two rounds in one conversation are two buckets, not one overwritten', () => {
  // the web console keys its streams by conversation and loses one of two; `round` is the fix
  let buckets = applyStreamFrame({}, frame({ delta: 'first' }), 100).buckets
  buckets = applyStreamFrame(buckets, frame({ round: 'r2', delta: 'second' }), 150).buckets
  assert.equal(streamOf(buckets, 'c1', 'r1').text, 'first')
  assert.equal(streamOf(buckets, 'c1', 'r2').text, 'second')
  assert.equal(streamsOf(buckets, 'c1').length, 2)
})

test('two conversations do not share a bucket even under the same round id', () => {
  let buckets = applyStreamFrame({}, frame({ delta: 'here' }), 100).buckets
  buckets = applyStreamFrame(buckets, frame({ cid: 'c2', delta: 'there' }), 100).buckets
  assert.equal(streamOf(buckets, 'c1', 'r1').text, 'here')
  assert.equal(streamOf(buckets, 'c2', 'r1').text, 'there')
  assert.equal(streamsOf(buckets, 'c1').length, 1)
})

test('a duplicate seq is dropped, so a reconnecting relay does not double the text', () => {
  const one = applyStreamFrame({}, frame({ delta: 'Hello' }), 100)
  const again = applyStreamFrame(one.buckets, frame({ delta: 'Hello' }), 200)
  assert.equal(again.changed, false)
  assert.equal(again.buckets, one.buckets, 'a dropped frame hands the same map back')
  assert.equal(streamOf(again.buckets, 'c1', 'r1').text, 'Hello')
})

test('a frame after done is dropped, however it is numbered', () => {
  let buckets = applyStreamFrame({}, frame({ delta: 'the end', done: true }), 100).buckets
  const late = applyStreamFrame(buckets, frame({ seq: 9, delta: '…more' }), 200)
  assert.equal(late.changed, false)
  assert.equal(streamOf(late.buckets, 'c1', 'r1').text, 'the end')
  assert.equal(streamOf(late.buckets, 'c1', 'r1').done, true)
})

test('the last batch and done in one frame keep the text', () => {
  const { buckets } = applyStreamFrame({}, frame({ delta: 'all done', done: true }), 100)
  const bucket = streamOf(buckets, 'c1', 'r1')
  assert.equal(bucket.text, 'all done')
  assert.equal(bucket.done, true)
})

test('a done for a round whose opening batch was lost still closes a clean line', () => {
  // the closing frame has to reach the bubble, or a line would spin under a run that is over
  const { buckets } = applyStreamFrame({}, frame({ seq: 4, done: true }), 100)
  const bucket = streamOf(buckets, 'c1', 'r1')
  assert.equal(bucket.text, '')
  assert.equal(bucket.done, true)
  assert.equal(bucket.seq, 4)
})

test('a tool step is a row, kept in order', () => {
  let buckets = applyStreamFrame({}, frame({ tool: { name: 'read_file', stage: 'call' } }), 100).buckets
  buckets = applyStreamFrame(buckets, frame({ seq: 2, tool: { name: 'read_file', stage: 'result', ok: true, summary: '12 lines' } }), 200).buckets
  const bucket = streamOf(buckets, 'c1', 'r1')
  assert.deepEqual(bucket.tools, [
    { name: 'read_file', stage: 'call', summary: '', ok: true },
    { name: 'read_file', stage: 'result', summary: '12 lines', ok: true },
  ])
})

test('a tool result that failed carries that, for a red row', () => {
  const { buckets } = applyStreamFrame({}, frame({ tool: { name: 'rm', stage: 'result', ok: false, summary: 'denied' } }), 100)
  assert.equal(streamOf(buckets, 'c1', 'r1').tools[0].ok, false)
})

test('a frame with no conversation or no round is ignored', () => {
  assert.equal(applyStreamFrame({}, frame({ cid: '' }), 100).changed, false)
  assert.equal(applyStreamFrame({}, frame({ round: '' }), 100).changed, false)
  assert.equal(applyStreamFrame({}, frame({ cid: '  ' }), 100).changed, false)
})

test('the newest batch comes first when a conversation\u2019s streams are listed', () => {
  let buckets = applyStreamFrame({}, frame({ round: 'r1', delta: 'a' }), 100).buckets
  buckets = applyStreamFrame(buckets, frame({ round: 'r2', delta: 'b' }), 300).buckets
  assert.deepEqual(streamsOf(buckets, 'c1').map((b) => b.round), ['r2', 'r1'])
})

test('a round keeps the device it opened with, whatever a later frame says', () => {
  // `from` names the run's device for the bubble's "from" line; a frame from another one is not
  // allowed to rename a round mid-flight, so the first name stands
  let buckets = applyStreamFrame({}, frame({ from: 'desk' }), 100).buckets
  buckets = applyStreamFrame(buckets, frame({ seq: 2, from: 'p8', delta: 'x' }), 200).buckets
  assert.equal(streamOf(buckets, 'c1', 'r1').from, 'desk')
})

// ---- what is still worth drawing ------------------------------------------------------

test('a settled round is left out, so the final synced text stands alone', () => {
  const { buckets } = applyStreamFrame({}, frame({ delta: 'x', done: true }), 100)
  const drawn = liveStreams(buckets, 'c1', { selfId: 'this', now: 100, settled: (b) => b.done })
  assert.deepEqual(drawn, [])
})

test('a quiet round ages out, so a spinner cannot outlive its run', () => {
  const { buckets } = applyStreamFrame({}, frame({ delta: 'x' }), 1_000)
  assert.equal(liveStreams(buckets, 'c1', { selfId: 'this', now: 2_000, ttlMs: 5_000 }).length, 1)
  assert.equal(liveStreams(buckets, 'c1', { selfId: 'this', now: 7_000, ttlMs: 5_000 }).length, 0)
})

test('pruning drops the settled and the quiet and leaves the running', () => {
  let buckets = applyStreamFrame({}, frame({ round: 'old', done: true }), 1_000).buckets
  buckets = applyStreamFrame(buckets, frame({ round: 'stale', seq: 1 }), 1_000).buckets
  buckets = applyStreamFrame(buckets, frame({ round: 'now', seq: 1, delta: 'live' }), 9_000).buckets
  const kept = pruneStreams(buckets, { now: 9_500, ttlMs: 5_000, settled: (b) => b.done })
  assert.deepEqual(Object.values(kept).map((b) => b.round), ['now'])
})

test('pruning an unchanged map hands the same object back', () => {
  const { buckets } = applyStreamFrame({}, frame({ delta: 'x' }), 9_000)
  assert.equal(pruneStreams(buckets, { now: 9_000 }), buckets)
})

// ---- the bubble\u2019s "from" line ------------------------------------------------------

test('the device a stream runs on is named, unless it is this computer', () => {
  const { buckets } = applyStreamFrame({}, frame({ delta: 'x' }), 100)
  const bucket = streamOf(buckets, 'c1', 'r1')
  assert.deepEqual(streamDevice(bucket, [device()], 'this'), device())
  assert.equal(streamDevice(bucket, [device()], 'desk'), null)
  assert.equal(streamDevice({ ...bucket, from: '' }, [device()], 'this'), null)
})

test('a stream from a device the account no longer lists names nothing', () => {
  const { buckets } = applyStreamFrame({}, frame({ delta: 'x' }), 100)
  assert.equal(streamDevice(streamOf(buckets, 'c1', 'r1'), [], 'this'), null)
})

// ---- reading the frame off the wire -----------------------------------------------------

test('a stream frame is read as it stands', () => {
  assert.deepEqual(
    readStreamFrame({ type: 'stream', cid: 'c1', from: 'desk', round: 'r1', seq: 3, delta: 'hi', done: false }),
    { cid: 'c1', round: 'r1', from: 'desk', seq: 3, delta: 'hi', reasoning: undefined, tool: undefined, done: false },
  )
})

test('a frame that is not a stream is left alone', () => {
  assert.equal(readStreamFrame({ type: 'working', cid: 'c1' }), null)
  assert.equal(readStreamFrame('stream'), null)
  assert.equal(readStreamFrame(null), null)
})

test('a frame with no conversation, no round, or nothing to draw is dropped', () => {
  assert.equal(readStreamFrame({ type: 'stream', round: 'r1', delta: 'x' }), null)
  assert.equal(readStreamFrame({ type: 'stream', cid: 'c1', delta: 'x' }), null)
  assert.equal(readStreamFrame({ type: 'stream', cid: 'c1', round: 'r1' }), null)
  assert.equal(readStreamFrame({ type: 'stream', cid: '  ', round: 'r1', delta: 'x' }), null)
})

test('a done with nothing else survives, to close a round whose batch was lost', () => {
  assert.deepEqual(readStreamFrame({ type: 'stream', cid: 'c1', round: 'r1', done: true }), {
    cid: 'c1', round: 'r1', from: '', seq: 0, delta: undefined, reasoning: undefined, tool: undefined, done: true,
  })
})

test('a tool step is read, and one without a name is no step at all', () => {
  assert.deepEqual(readStreamFrame({ type: 'stream', cid: 'c1', round: 'r1', tool: { name: 'grep', stage: 'result', ok: false, summary: 'denied' } }).tool, {
    name: 'grep', stage: 'result', ok: false, summary: 'denied',
  })
  assert.equal(readStreamFrame({ type: 'stream', cid: 'c1', round: 'r1', tool: { stage: 'call' } }), null)
})

test('a seq that is not a number reads as zero rather than NaN', () => {
  assert.equal(readStreamFrame({ type: 'stream', cid: 'c1', round: 'r1', delta: 'x', seq: 'oops' }).seq, 0)
  assert.equal(readStreamFrame({ type: 'stream', cid: 'c1', round: 'r1', delta: 'x' }).seq, 0)
})

test('a wire frame goes into its bucket through the reader', () => {
  const parsed = readStreamFrame({ type: 'stream', cid: 'c1', from: 'desk', round: 'r1', seq: 1, delta: 'Hello' })
  const { buckets } = applyStreamFrame({}, parsed, 100)
  assert.equal(streamOf(buckets, 'c1', 'r1').text, 'Hello')
})
