// The Mac reading, against the same eighteen cases the Android unit test uses.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reading } from '../src/client/device-mention.ts'

const NAMES = ['Mac mini', 'MacBook Pro', 'Pixel 8', 'Desk']
const CASES = [
  ['@Pixel 8 open the calendar', { name: 'Pixel 8', text: 'open the calendar' }],
  ['@Desk: build it', { name: 'Desk', text: 'build it' }],
  ['@Desk, build it', { name: 'Desk', text: 'build it' }],
  ['@Desk，build it', { name: 'Desk', text: 'build it' }],
  ['@Desk：build it', { name: 'Desk', text: 'build it' }],
  ['@MacBook Pro run the tests', { name: 'MacBook Pro', text: 'run the tests' }],
  ['@Mac mini restart', { name: 'Mac mini', text: 'restart' }],
  ['@MacBooks are nice', null],
  ['@pix what is on screen', { name: 'Pixel 8', text: 'what is on screen' }],
  ['@mac restart', null],
  ['@Desk', null],
  ['@Desk  ', null],
  ['@Desk:', null],
  ['Desk build it', null],
  ['hi @Desk build it', null],
  ['@', null],
  ['@Laptop build it', null],
  ['@desk build it', { name: 'Desk', text: 'build it' }],
]

test('the Mac reading agrees with the phone and the runtime', () => {
  for (const [text, want] of CASES) {
    assert.deepEqual(reading(text, NAMES), want, text)
  }
})
