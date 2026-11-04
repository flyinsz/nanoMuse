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
import { useCallback, useEffect, useRef } from "react";
import { useStore } from "../store";
import { useT } from "../i18n";
import { centringScroll, faceRow, type DeviceFace } from "../device-strip";
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

  const row = faceRow(state.hub?.devices ?? [], { chatDevice, threads: state.threads });

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
    // a roll to a *different* device animates; the first fit (nothing remembered) and a
    // re-render that lands on the device already in the middle both stay still
    const id = row.middle?.device.id ?? "";
    const moved = lastFocused !== undefined && lastFocused !== id;
    lastFocused = id;
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
    box.scrollTo({ left, behavior: moved ? "smooth" : "auto" });
  }, [row.middle?.device.id]);

  const open = useCallback(
    async (face: DeviceFace) => {
      const d = face.device;
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
