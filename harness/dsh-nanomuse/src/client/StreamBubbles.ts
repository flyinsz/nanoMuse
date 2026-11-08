/**
 * A turn being written on the account's other devices, drawn in this conversation as it goes
 * (contract C13, §4). `RemoteBubbles.ts` shows the turns that already landed; this shows the
 * ones still running, from the `stream` frames the relay fans out.
 *
 * Like `RemoteBubbles.ts` and `FenceCards.ts`: a MutationObserver over the document, idempotent
 * sweeps, nothing of React's touched. Each round is one `.nm-stream` bubble, keyed by the
 * conversation and the round (`stream-view.ts`), so two runs in one chat never overwrite each
 * other; a round's bubble is updated in place rather than redrawn, so the words do not flicker
 * as batches land. A round that says `done` keeps its bubble a short grace while its final text
 * arrives as an ordinary synced turn, then goes — a half-written bubble must not outlive it.
 *
 * The rules are in `stream-view.ts` (pure, and checked there); this file only places nodes.
 */
import { peekLive, subscribeLive, type Live, type LiveStream } from './live.ts'
import { mdToHtml } from './markdown-io.ts'
import { streamBubbles, toolLine } from './stream-view.ts'
import type { Translate } from './api.ts'

const KEY = 'data-nm-stream-key'
const CID = 'data-nm-stream-cid'
const ROUND = 'data-nm-stream-round'
/** Mutations within this window become one sweep. */
const SWEEP_DELAY_MS = 100
/** While a round runs, the bubble is redrawn on this beat so a quiet stretch still ages out. */
const TICK_MS = 5_000

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** Where a bubble goes when the chat has no rows of its own yet: just above the composer. */
function seatOf(content: HTMLElement): HTMLElement | null {
  return content.querySelector<HTMLElement>('[data-conversation-scroll] > [data-composer-seat]')
}

/**
 * One bubble: the agent's side of the thread, since a run from elsewhere is a reply being written.
 *
 * No caption of its own. A settled turn from another device already wears the harness's own quiet
 * `From <device>` line (`nm-remote-from`) and the run's progress reads on the harness's own
 * `nm-remote-working` line, both put there by `RemoteBubbles`; a second, differently-sized label
 * here was a banner in a chat that had none. This is the words alone, in the shape the words
 * will have when the turn settles.
 */
function bubble(t: Translate, stream: LiveStream, deviceName: string): HTMLElement {
  const root = el('div', 'nm-stream nm-remote-assistant')
  root.setAttribute(KEY, `${stream.cid}\u0000${stream.round}`)
  root.setAttribute(CID, stream.cid)
  root.setAttribute(ROUND, stream.round)
  // The blocks are built by `paint`: prose and steps in the order the turn wrote them, each run of
  // prose wearing `nm-md`, the harness's own Markdown shape (the rooms' bodies wear it too).
  root.append(el('div', 'nm-stream-flow'))
  return root
}

/** Redraw one bubble's words from its bucket; nodes are reused so nothing flashes between batches. */
function paint(root: HTMLElement, stream: LiveStream, t: Translate): void {
  root.classList.toggle('nm-stream-done', stream.done)
  // The reasoning is a quieter line of its own above the words, as the harness folds it; it stays
  // as written (the final turn carries the fold, but until it lands this is all there is to read).
  const body = root.querySelector<HTMLElement>('.nm-stream-body')
  const reasoning = root.querySelector<HTMLElement>('.nm-stream-reasoning')
  if (stream.reasoning.trim()) {
    if (reasoning) reasoning.textContent = stream.reasoning
    else body?.insertAdjacentElement('beforebegin', el('div', 'nm-stream-reasoning', stream.reasoning))
  } else reasoning?.remove()
  // The turn in the order it happened: its prose, then each step where the prose stood when the
  // step arrived, then the prose after it. A turn reads, calls a tool, says what it found and
  // calls another, so a bubble that put every step after every paragraph would say the opposite
  // of what happened. Built as a run of blocks and swapped whole; the signature is what the
  // blocks would say, so a batch that changed nothing costs no DOM work.
  const blocks = turnBlocks(stream)
  const signature = blocks.map((b) => (b.kind === 'step' ? `s${b.bad ? '!' : ''}${b.line}` : `t${b.md.length}`)).join('\u0000')
  const flow = root.querySelector<HTMLElement>('.nm-stream-flow') ?? el('div', 'nm-stream-flow')
  if (flow.getAttribute('data-nm-stream-flow') !== signature) {
    flow.replaceChildren(
      ...blocks.map((b) => {
        if (b.kind === 'step') return el('div', b.bad ? 'nm-stream-step nm-stream-step-bad' : 'nm-stream-step', b.line)
        const md = el('div', 'nm-stream-body nm-md')
        md.innerHTML = mdToHtml(b.md)
        return md
      }),
    )
    flow.setAttribute('data-nm-stream-flow', signature)
  }
  if (!flow.parentElement) root.append(flow)
  // The breathing light while the run goes; a finished round keeps its bubble but stops glowing.
  const light = root.querySelector<HTMLElement>('.nm-stream-live')
  if (stream.done) light?.remove()
  else if (!light) root.insertBefore(el('span', 'nm-stream-live'), root.firstChild)
}

/** One block of a turn, in the order it happened: a run of prose, or one step. */
type TurnBlock = { kind: 'text'; md: string } | { kind: 'step'; line: string; bad: boolean }

/**
 * A turn's prose and its steps, interleaved the way they happened. Each step carries how much
 * text had been written when it arrived (`textAt`), so cutting the text at those marks puts
 * every step back where it belongs. A step whose mark falls past the end of the text (the words
 * for it have not arrived yet) is left for the end, where it will read once they do.
 */
export function turnBlocks(stream: LiveStream, t?: Translate): TurnBlock[] {
  const text = stream.text
  const steps = stream.tools
    .map((tool) => ({ at: Math.max(0, Math.min(tool.textAt, text.length)), line: toolLine(tool), bad: tool.stage === 'result' && !tool.ok }))
    .sort((a, b) => a.at - b.at)
  const out: TurnBlock[] = []
  let cursor = 0
  for (const step of steps) {
    if (step.at > cursor) out.push({ kind: 'text', md: text.slice(cursor, step.at) })
    out.push({ kind: 'step', line: step.line, bad: step.bad })
    cursor = Math.max(cursor, step.at)
  }
  if (cursor < text.length) out.push({ kind: 'text', md: text.slice(cursor) })
  return out.filter((b) => b.kind === 'step' || b.md.trim() !== '')
}

/** Watch the document for running turns and draw them; returns the stop function. */
export function renderStreamBubbles(t: Translate): () => void {
  let live = peekLive()
  let scheduled: ReturnType<typeof setTimeout> | undefined
  let ticker: ReturnType<typeof setInterval> | undefined
  let stopped = false

  const sweep = () => {
    scheduled = undefined
    const streams = live.streams
    const selfId = live.hub.deviceId
    for (const content of document.querySelectorAll<HTMLElement>('[data-conversation-content][data-conversation-session]')) {
      const sessionId = content.getAttribute('data-conversation-session') ?? ''
      const shown = streamBubbles(streams, sessionId, { selfId })
      // The bubbles of this chat, by key, so one that is gone is removed and the rest reused.
      const nodes = new Map<string, HTMLElement>()
      for (const node of content.querySelectorAll<HTMLElement>('.nm-stream')) {
        nodes.set(node.getAttribute(KEY) ?? '', node)
      }
      if (shown.length === 0) {
        for (const node of nodes.values()) node.remove()
        continue
      }
      const flow = content.querySelector<HTMLElement>('[data-chat-flow]')
      const scroll = content.querySelector<HTMLElement>('[data-conversation-scroll]')
      const seat = seatOf(content)
      // The oldest first, so the newest batch sits nearest the composer, after the one before it.
      let tail: HTMLElement | null = null
      for (const stream of shown) {
        const key = `${stream.cid}\u0000${stream.round}`
        let node = nodes.get(key)
        nodes.delete(key)
        if (!node) node = bubble(t, stream, stream.deviceName)
        paint(node, stream, t)
        if (tail) {
          // the order the rounds started in; only moved when it is not already there
          if (tail.nextElementSibling !== node) tail.insertAdjacentElement('afterend', node)
        } else if (!node.isConnected) {
          // Into the chat's own message flow, where the landed turns are: that container carries
          // the thread's width and centring, so a running turn lines up with the answers above it
          // instead of hugging the edge of the scroller. The seat above the composer is the
          // fallback for a chat with no flow of its own, and the scroller the last resort.
          if (flow) flow.append(node)
          else if (seat) seat.insertAdjacentElement('beforebegin', node)
          else if (scroll) scroll.append(node)
          else content.append(node)
        }
        tail = node
      }
      // a bubble whose round is gone (settled, quiet, or another chat's): it goes with it
      for (const node of nodes.values()) node.remove()
    }
  }

  const schedule = () => {
    if (scheduled || stopped) return
    scheduled = setTimeout(() => window.requestAnimationFrame(sweep), SWEEP_DELAY_MS)
  }

  /** Whether a mutation is one the bubbles made themselves: no sweep for those. */
  const ours = (m: MutationRecord): boolean => {
    const target = m.target instanceof Element ? m.target : m.target.parentElement
    if (target?.closest('.nm-stream')) return true
    const nodes = [...m.addedNodes, ...m.removedNodes]
    return nodes.length > 0 && nodes.every((n) => n instanceof Element && n.classList.contains('nm-stream'))
  }
  const observer = new MutationObserver((records) => {
    if (records.some((m) => !ours(m))) schedule()
  })
  observer.observe(document.body, { childList: true, subtree: true })
  // A new batch, or a round that settled: the chats on screen are drawn again from the snapshot.
  // The host sends a fresh array on every broadcast (a hands step, a notice), so this compares
  // what would be drawn rather than the array's identity: nothing moved, nothing is swept.
  const signature = (next: Live): string => (next.streams ?? []).map((s) => `${s.cid}\u0000${s.round}\u0000${s.seq}\u0000${s.text}\u0000${s.reasoning}\u0000${s.tools.length}\u0000${s.done ? 1 : 0}\u0000${s.deviceName}`).join('\n')
  let seen = signature(live)
  const offLive = subscribeLive((next) => {
    live = next
    const now = signature(next)
    if (now === seen) return
    seen = now
    schedule()
  })
  // A round with no `done` ages out on its own; a round that finished is dropped past its grace.
  // Only while one is on screen: an idle page does no work.
  const tick = () => {
    if (stopped) return
    if ((live.streams ?? []).length > 0) schedule()
  }
  ticker = setInterval(tick, TICK_MS)

  schedule()
  return () => {
    stopped = true
    observer.disconnect()
    offLive()
    if (scheduled) clearTimeout(scheduled)
    if (ticker) clearInterval(ticker)
    for (const node of document.querySelectorAll('.nm-stream')) node.remove()
  }
}
