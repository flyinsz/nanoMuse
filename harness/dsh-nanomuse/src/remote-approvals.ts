/**
 * A question raised by work sent to *another* device (`@<device> …` at this computer's
 * composer), put to the person here, where they asked for it.
 *
 * `docs/hub.md` is explicit: the cards of a `task` travel back to the caller. The runtime
 * does this in `nanomuse/hub/service.py` (an `approval` event goes out, `approve` comes
 * back), and another nanoMuse desktop does it in `task.ts`'s `onApproval`. What was missing
 * here is the asking side of that exchange: `askDevice` read `tool`, `tool_result`, `text`
 * and `error` frames but let an `approval` frame fall on the floor, so a step on the other
 * device that needed a word was never answered and the run sat until the target's own
 * timeout gave up on it.
 *
 * The card itself is the shape `ApprovalDesk` produces (`PendingApproval`), so the console
 * draws it from `live.approvals` with no new rendering, and `POST approvals/<id>` is the
 * same door the person already answers through. What differs is what the row says: this
 * desk knows the question came from elsewhere, and it keeps no grant (an *Always* here could
 * only name that device's tool and target, which this computer cannot vouch for).
 *
 * Plain state, no Cordis: `cloud.ts` owns the wiring, so the tests can drive it.
 */
import type { PendingApproval } from './desk.ts'

/** The question as the target's frame carried it. */
export interface RemoteQuestion {
  /** The target's own id for the card, echoed back in `approve {approval_id}`. */
  approvalId: string
  /** The device whose Muse is asking, for the card's title and the person's bearings. */
  device: string
  /** What the step would do, in the asker's words. */
  preview: string
  /** Why it wants it. */
  reason: string
  /** How the target rated it (`low`/`moderate`/`high`); carried for the log, not shown. */
  risk: string
}

/**
 * What the person's card settled to: `true`/`false` is their word here (and the caller sends
 * `approve` back), `null` means it was settled elsewhere and nothing should be sent — sending
 * a *Deny* then would overrule an answer the target already gave itself.
 */
export type RemoteAnswer = boolean | null

export class RemoteApprovals {
  /** The cards out, keyed by the host-side id the console's `approvals/<id>` route names. */
  private readonly pending = new Map<string, { row: PendingApproval; settle(answer: RemoteAnswer): void }>()
  private seq = 0

  /** @param changed - called when the list moves, so the console hears (a `broadcast`). */
  constructor(private readonly changed: () => void) {}

  /** The cards out, oldest first, in the shape the console's approval cards already read. */
  list(): PendingApproval[] {
    return [...this.pending.values()].map((p) => p.row).sort((a, b) => a.at - b.at)
  }

  /** Whether this desk is the one holding `id` (so the answer route knows where it goes). */
  holds(id: string): boolean {
    return this.pending.has(id)
  }

  /**
   * Put the question to the person and wait for their word. `true` lets the step run, `false`
   * is *Deny*, `null` when it was answered elsewhere first (nothing to send back then).
   */
  ask(question: RemoteQuestion): Promise<RemoteAnswer> {
    this.seq += 1
    const id = `rp-${Date.now().toString(36)}-${this.seq.toString(36)}`
    const row: PendingApproval = {
      id,
      // Not a session of this computer's: the log line and the console's "which chat is
      // waiting" walk (`deskMoved`) read `sessionId`, and a remote run is not one of ours.
      sessionId: `remote:${question.device}`,
      toolName: 'delegate',
      summary: question.preview || question.reason || question.device,
      summaryZh: '',
      purpose: question.reason,
      // No app of this computer stands behind it, so the card offers no standing answer
      // (`approvalActions` shows *Always* only when `app` is set).
      app: '',
      scheduleId: '',
      status: 'pending',
      at: Date.now(),
    }
    const wait = new Promise<RemoteAnswer>((resolve) => this.pending.set(id, { row, settle: resolve }))
    this.changed()
    return wait
  }

  /** The person's answer from the console; false when the card is gone already. */
  decide(id: string, approved: boolean): boolean {
    return this.settle(id, approved)
  }

  /**
   * The card was answered somewhere else (the target's own screen, or a phone of the account):
   * take it down and send nothing back — the target already knows.
   */
  forget(id: string): void {
    this.settle(id, null)
  }

  /**
   * The run ended with the card still up (the target gave up, the person's turn was stopped):
   * take it down and send nothing back — the target's own teardown cancels its pending
   * approvals, so an `approve` from here would only be a no-op, and a *Deny* could overrule
   * a step it settled itself in the last moment.
   */
  releaseDevice(device: string): void {
    for (const [id, p] of [...this.pending]) {
      if (p.row.sessionId === `remote:${device}`) this.settle(id, null)
    }
  }

  private settle(id: string, answer: RemoteAnswer): boolean {
    const p = this.pending.get(id)
    if (!p) return false
    this.pending.delete(id)
    p.settle(answer)
    this.changed()
    return true
  }
}
