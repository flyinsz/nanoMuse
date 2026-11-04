/**
 * The account's devices as a strip just above the composer: one round disc per device, the one
 * whose chat is open large in the middle and the rest small on either side (see `device-strip.ts`
 * for the rules).
 *
 * A tap rolls the strip until the device picked is the middle one, growing as it travels, and
 * opens that device's chat. The roll is what makes the strip read as one thing being turned
 * rather than a row of buttons: the person watches the device they picked come to the middle and
 * become the one in front. The scroll is worked out by hand and a CSS transition on the size
 * does the growing, so both clients roll the same way.
 *
 * The disc carries what the device *is* — a computer or a phone — rather than the agent's face:
 * the account's Muse wears one face for every device of it, so a face says nothing about which
 * device a disc stands for. The name under each disc says the rest, and the device being held
 * says "This device" rather than the account's name for it, which is the same on every device
 * and so says nothing about which disc is this one.
 *
 * Offline devices are drawn, faint rather than hidden: one that is merely asleep is still the
 * person's, and a tap says so rather than opening a chat that cannot answer.
 */
import { Monitor, Smartphone } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { useT } from "../i18n";
import { centringScroll, faceRow, type DeviceFace } from "../device-strip";
import type { HubDevice } from "../types";
import { api } from "../api";
import { cx } from "../util";

/** One device's disc and name, as the strip draws them. */
function Face({
  face,
  focused,
  onClick,
  label,
  name,
}: {
  face: DeviceFace;
  focused: boolean;
  onClick: () => void;
  label: string;
  /** what the strip writes under the disc: "This device" for the one being held */
  name: string;
}) {
  const d = face.device;
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-current={focused ? "true" : undefined}
      className="flex w-[58px] shrink-0 flex-col items-center gap-0.5"
    >
      {/* the slot is one size whatever the disc does, so nothing beside it shifts as one grows */}
      <span className="flex h-[46px] items-center justify-center">
        <span
          className={cx(
            "flex h-[46px] w-[46px] items-center justify-center rounded-full border transition-transform duration-300 ease-out",
            focused
              ? "border-accent bg-accent/16 text-accent"
              : "border-border bg-surface-2 text-muted",
            !d.online && "opacity-40",
          )}
          style={{ transform: focused ? "scale(1)" : "scale(0.61)" }}
        >
          {d.kind === "phone" ? <Smartphone size={22} /> : <Monitor size={22} />}
        </span>
      </span>
      <span
        className={cx(
          "w-[58px] truncate text-center leading-tight transition-colors",
          focused ? "font-medium text-fg" : "text-muted",
          !d.online && "opacity-50",
        )}
        style={{ fontSize: focused ? 10 : 9 }}
      >
        {name}
      </span>
    </button>
  );
}

/**
 * The device the strip was last fitted to, or undefined before the first fit. Kept outside the
 * component on purpose: a tap opens another chat, which rebuilds the composer subtree and with
 * it this component, so a ref inside would be born fresh on every tap and every roll would be
 * treated as a first fit and land without animating — which is exactly the bug this fixes.
 */
let lastFocused: string | undefined;

export function DeviceFaces({ chatDevice }: { chatDevice: string }) {
  const { state, dispatch, toast } = useStore();
  const t = useT();
  const strip = useRef<HTMLDivElement>(null);

  // The runtime's view keeps this device apart from the others: `device` is this runtime, and
  // `devices` is the relay's list of the *other* devices of the account, which never includes
  // this one. The strip is the account's Muses, so this device belongs in the row — put in
  // first and marked, which is what `muses` reads. Without this the row drew only the other
  // devices, this page's own face was missing, and "the middle" fell back to nothing whenever
  // no device's chat was open.
  const everyone = useMemo<HubDevice[]>(() => {
    const self = state.hub?.device;
    const others = state.hub?.devices ?? [];
    if (!self?.id) return others;
    if (others.some((d) => d.id === self.id)) return others;
    return [{ id: self.id, name: self.name, kind: self.kind, online: true, this: true }, ...others];
  }, [state.hub?.device, state.hub?.devices]);

  const row = faceRow(everyone, { chatDevice, threads: state.threads });

  // Extracted so the effect's dependency list is three plain values eslint can check.
  const middleId = row.middle?.device.id ?? "";
  const sideCount = row.left.length + row.right.length;

  // Bumped on every pick, so the roll below runs even when the *middle* does not change. That
  // is the ordinary case: picking the device already in the middle, or picking this page's own
  // face while it is already the middle one, moves the strip nowhere else and would otherwise
  // leave the effect's dependencies untouched and the roll unfired.
  const [pick, setPick] = useState(0);

  // Roll the device whose chat is open to the middle of the strip. The first fit lands it
  // without a scroll so a chat that opens on a device does not slide under the reader's eyes;
  // every pick after that animates.
  //
  // The distance comes from `centringScroll` (src/device-strip.ts), which works from the two
  // boxes' screens coordinates: neither `scrollIntoView({ inline: "center" })` nor
  // `element.offsetLeft` is right here — the first resolves "centre" against the nearest
  // scrollable ancestor differently in every engine, the second is measured from the offset
  // parent, which a flex row does not establish. The rule lives there so it can be checked
  // without a browser, which is what the two earlier attempts at this were not.
  useEffect(() => {
    const box = strip.current;
    if (!box) return;
    const el = box.querySelector<HTMLElement>('[aria-current="true"]');
    if (!el) return;
    // The very first fit lands without scrolling — a chat that opens on a device should not
    // slide under the reader's eyes. Everything after that rolls, including a pick of the device
    // already in the middle (that is what `pick` is for): a tap should always be answered by
    // the strip moving, and "it is already centred" is only true of where it sits, not of the
    // fact that the person just asked for it.
    const first = lastFocused === undefined;
    lastFocused = middleId;
    const b = box.getBoundingClientRect();
    const f = el.getBoundingClientRect();
    const left = centringScroll({
      boxLeft: b.left,
      boxWidth: box.clientWidth,
      faceLeft: f.left,
      faceWidth: el.offsetWidth,
      scrollLeft: box.scrollLeft,
      contentWidth: box.scrollWidth,
    });
    box.scrollTo({ left, behavior: first ? "auto" : "smooth" });
    // `pick` is what makes a pick of the device already in the middle roll too; the other two
    // cover the row itself changing (a device appears or leaves, or the chat's device changes)
  }, [middleId, sideCount, pick]);

  const open = useCallback(
    async (face: DeviceFace) => {
      const d = face.device;
      // every pick asks the strip to roll, whether or not the middle ends up elsewhere
      setPick((n) => n + 1);
      // The device being held is this page's own Muse, which is the main chat — not a chat
      // *with* it. `POST /api/hub/ask` cannot open one either: the runtime's `hub_ask` resolves
      // the device through `hub.device`/`hub.find`, and both look only at the *other* devices,
      // so asking for this one answered 404 "no device matches". Returning to "main" is what the
      // strip's own face means, and what picking it did before there was a strip at all.
      if (d.this) {
        dispatch({ type: "activeThread", thread: "main" });
        return;
      }
      if (!d.online) {
        toast(t("{device} is not connected right now.", { device: d.name }));
        return;
      }
      if (face.thread) {
        dispatch({ type: "activeThread", thread: face.thread });
        return;
      }
      try {
        const r = await api.askDevice(d.id);
        dispatch({ type: "ws", msg: { kind: "thread", thread: r.thread } });
        dispatch({ type: "activeThread", thread: r.thread.id });
      } catch (e) {
        toast((e as Error).message);
      }
    },
    [dispatch, t, toast],
  );

  if (!row.middle && row.left.length + row.right.length === 0) return null;

  const label = (f: DeviceFace) =>
    f.device.online ? t("Open the chat with {device}", { device: f.device.name }) : t("{device} is offline", { device: f.device.name });

  // The device this page is signed in as wears the account's name for it, which is the same
  // name every other device wears (the profile is one per account) — so under its own disc it
  // says nothing. "This device" is what the person knows that one by.
  const name = (f: DeviceFace) => (f.device.this ? t("This device") : f.device.name);

  return (
    <div
      ref={strip}
      className="flex items-end gap-1 overflow-x-auto px-2 pb-1"
      role="list"
      aria-label={t("Your devices")}
      style={{ scrollbarWidth: "none" }}
    >
      {/* Half a strip of slack on each end, so the first and the last device can reach the
          middle too. It is half the strip rather than a fixed slice of the viewport: two 40vw
          ends left only 20vw of room for the devices to overflow into, so on a wide window with
          a few devices the strip never overflowed at all and "roll to the middle" had nothing to
          scroll — which is why the console never rolled while the phone always did (there the
          slack is `(viewport - slot) / 2` and the content is always wider than its box). At half
          the width the same is true here, and the roll is the same gesture on both. */}
      <span aria-hidden className="w-1/2 shrink-0" />
      {[...row.left, ...(row.middle ? [row.middle] : []), ...row.right].map((f) => (
        <Face
          key={f.device.id}
          face={f}
          focused={f.device.id === row.middle?.device.id}
          onClick={() => void open(f)}
          label={label(f)}
          name={name(f)}
        />
      ))}
      <span aria-hidden className="w-1/2 shrink-0" />
    </div>
  );
}
