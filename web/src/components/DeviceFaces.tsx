/**
 * The account's Muses as faces beside the agent's own in the header, the one whose chat is open
 * drawn large in the middle (see `device-strip.ts` for the rules). A tap opens that device's
 * chat, or returns to it when it already has one, which is what the runtime does for a mention
 * (`POST /api/hub/ask`, `ask_device`).
 *
 * Every device wears the same face — the account's profile is one per account — so the size and
 * the name under each face are what tell them apart. Under `CLIP_MIN_PX` the Avatar shows a
 * still rather than a clip, which is the same rule the rest of the app follows for small faces.
 *
 * Offline devices are drawn, faint rather than hidden: one that is merely asleep is still the
 * person's, and a tap says so rather than opening a chat that cannot answer.
 */
import { useCallback } from "react";
import { useStore } from "../store";
import { useT } from "../i18n";
import { faceRow, type DeviceFace } from "../device-strip";
import { api } from "../api";
import { cx } from "../util";
import { Avatar } from "./Avatar";
import type { Profile, Status } from "../types";

/** One Muse's face and name, as the row draws them. */
function Face({
  face,
  profile,
  status,
  size,
  focused,
  onClick,
  label,
}: {
  face: DeviceFace;
  profile: Profile | null;
  status: Status;
  size: number;
  /** the one whose chat is open: drawn larger, and marked as the current one for a reader */
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
      className="flex shrink-0 flex-col items-center gap-0.5"
    >
      <span className={cx("block", !d.online && "opacity-35")}>
        {/* a device that is not up has nothing under way, so it takes no status of its own */}
        <Avatar profile={profile} status={d.online ? status : undefined} size={size} />
      </span>
      <span
        className={cx(
          "w-[76px] truncate text-center text-[10px] leading-tight",
          focused ? "font-medium text-fg" : "text-muted",
          !d.online && "opacity-50",
        )}
      >
        {d.name}
      </span>
    </button>
  );
}

export function DeviceFaces({
  chatDevice,
  profile,
  status,
}: {
  chatDevice: string;
  profile: Profile | null;
  status: Status;
}) {
  const { state, dispatch, toast } = useStore();
  const t = useT();

  const row = faceRow(state.hub?.devices ?? [], { chatDevice, threads: state.threads });

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
    <div className="flex w-full items-center justify-center gap-1" role="list" aria-label={t("Your devices")}>
      <div className="flex min-w-0 flex-1 items-center justify-end gap-1 overflow-x-auto">
        {row.left.map((f) => (
          <Face key={f.device.id} face={f} profile={profile} status={status} size={28} focused={false} onClick={() => void open(f)} label={label(f)} />
        ))}
      </div>
      {row.middle && (
        <Face
          face={row.middle}
          profile={profile}
          status={status}
          size={40}
          focused
          onClick={() => void open(row.middle as DeviceFace)}
          label={label(row.middle)}
        />
      )}
      <div className="flex min-w-0 flex-1 items-center justify-start gap-1 overflow-x-auto">
        {row.right.map((f) => (
          <Face key={f.device.id} face={f} profile={profile} status={status} size={28} focused={false} onClick={() => void open(f)} label={label(f)} />
        ))}
      </div>
    </div>
  );
}
