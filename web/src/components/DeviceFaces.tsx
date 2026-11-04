/**
 * The account's devices as a strip just above the composer: one round disc per device, the one
 * whose chat is open large in the middle and the rest small on either side (see `device-strip.ts`
 * for the rules).
 *
 * A tap rolls the strip until the device picked is the middle one, growing as it travels, and
 * opens that device's chat. The roll is what makes the strip read as one thing being turned
 * rather than a row of buttons: the person watches the device they picked come to the middle and
 * become the one in front. `scrollIntoView({ inline: "center" })` does the moving and a CSS
 * transition on the size does the growing, both of which the browser animates itself.
 *
 * The disc carries what the device *is* — a computer or a phone — rather than the agent's face:
 * the account's Muse wears one face for every device of it, so a face says nothing about which
 * device a disc stands for. The name under each disc says the rest.
 *
 * Offline devices are drawn, faint rather than hidden: one that is merely asleep is still the
 * person's, and a tap says so rather than opening a chat that cannot answer.
 */
import { Monitor, Smartphone } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import { useStore } from "../store";
import { useT } from "../i18n";
import { faceRow, type DeviceFace } from "../device-strip";
import { api } from "../api";
import { cx } from "../util";

/** One device's disc and name, as the strip draws them. */
function Face({
  face,
  focused,
  onClick,
  label,
}: {
  face: DeviceFace;
  focused: boolean;
  onClick: () => void;
  label: string;
}) {
  const d = face.device;
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-current={focused ? "true" : undefined}
      className="flex w-[74px] shrink-0 flex-col items-center gap-0.5"
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
          "w-[74px] truncate text-center leading-tight transition-colors",
          focused ? "font-medium text-fg" : "text-muted",
          !d.online && "opacity-50",
        )}
        style={{ fontSize: focused ? 10 : 9 }}
      >
        {d.name}
      </span>
    </button>
  );
}

export function DeviceFaces({ chatDevice }: { chatDevice: string }) {
  const { state, dispatch, toast } = useStore();
  const t = useT();
  const strip = useRef<HTMLDivElement>(null);

  const row = faceRow(state.hub?.devices ?? [], { chatDevice, threads: state.threads });

  // Roll the device whose chat is open to the middle of the strip. The first fit lands it
  // without a scroll so a chat that opens on a device does not slide under the reader's eyes;
  // every pick after that animates.
  const landed = useRef(false);
  useEffect(() => {
    const el = strip.current?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!el) return;
    const still = !landed.current;
    landed.current = true;
    el.scrollIntoView({ inline: "center", block: "nearest", behavior: still ? "auto" : "smooth" });
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

  return (
    <div
      ref={strip}
      className="flex items-end gap-1.5 overflow-x-auto px-2 pb-1"
      role="list"
      aria-label={t("Your devices")}
      style={{ scrollbarWidth: "none" }}
    >
      {/* half a strip of slack on each end, so the first and the last device can reach the middle */}
      <span aria-hidden className="w-[40vw] shrink-0" />
      {[...row.left, ...(row.middle ? [row.middle] : []), ...row.right].map((f) => (
        <Face
          key={f.device.id}
          face={f}
          focused={f.device.id === row.middle?.device.id}
          onClick={() => void open(f)}
          label={label(f)}
        />
      ))}
      <span aria-hidden className="w-[40vw] shrink-0" />
    </div>
  );
}
