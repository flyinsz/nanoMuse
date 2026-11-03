/**
 * The device strip above the composer (see `device-strip.ts` for the rules): one round avatar
 * per device of the account, the one the open chat is addressed to drawn larger, and a tap on
 * another opens (or returns to) that device's chat.
 *
 * Kept out of `ChatScreen.tsx` so the screen's own diff stays small.
 */
import { Monitor, Smartphone } from "lucide-react";
import { useCallback, useState } from "react";
import { useStore } from "../store";
import { useT } from "../i18n";
import { deviceStrip, type DeviceChip } from "../device-strip";
import { api } from "../api";
import { cx } from "../util";
import type { HubDevice } from "../types";

/** The device's own icon, as the account's device list draws it. */
function KindIcon({ kind, size }: { kind: string; size: number }) {
  return kind === "phone" ? <Smartphone size={size} /> : <Monitor size={size} />;
}

export function DeviceStrip({ chatDevice }: { chatDevice: string }) {
  const { state, dispatch, toast } = useStore();
  const t = useT();
  const [busy, setBusy] = useState<string | null>(null);

  const chips = deviceStrip(state.hub?.devices ?? [], {
    chatDevice,
    threads: state.threads,
  });

  const open = useCallback(
    async (chip: DeviceChip) => {
      if (!chip.device.online) {
        toast(t("{device} is not connected right now.", { device: chip.device.name }));
        return;
      }
      if (chip.thread) {
        dispatch({ type: "activeThread", thread: chip.thread });
        return;
      }
      setBusy(chip.device.id);
      try {
        const r = await api.askDevice(chip.device.id);
        dispatch({ type: "ws", msg: { kind: "thread", thread: r.thread } });
        dispatch({ type: "activeThread", thread: r.thread.id });
      } catch (e) {
        toast((e as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [dispatch, t, toast],
  );

  if (chips.length === 0) return null;

  return (
    <div
      className="mb-2 flex items-end gap-3 overflow-x-auto px-2 pb-1"
      role="list"
      aria-label={t("Your devices")}
    >
      {chips.map((chip) => {
        const d: HubDevice = chip.device;
        const size = chip.focused ? "h-12 w-12" : "h-9 w-9";
        const icon = chip.focused ? 20 : 16;
        return (
          <button
            key={d.id}
            type="button"
            role="listitem"
            disabled={busy === d.id}
            onClick={() => void open(chip)}
            title={d.online ? t("Open the chat with {device}", { device: d.name }) : t("{device} is offline", { device: d.name })}
            aria-current={chip.focused ? "true" : undefined}
            className="flex shrink-0 flex-col items-center gap-1"
          >
            <span
              className={cx(
                "flex items-center justify-center rounded-full border transition-all",
                size,
                chip.focused ? "border-accent bg-accent/12 text-accent" : "border-border bg-surface text-muted",
                !d.online && "opacity-40",
                busy === d.id && "animate-pulse",
              )}
            >
              <KindIcon kind={d.kind} size={icon} />
            </span>
            <span
              className={cx(
                "max-w-[64px] truncate text-[11px]",
                chip.focused ? "font-medium text-fg" : "text-muted",
                !d.online && "opacity-50",
              )}
            >
              {d.name}
            </span>
          </button>
        );
      })}
    </div>
  );
}
