import type { DeviceType } from "@/lib/ipc";
import { ICON_PATHS, ICON_STROKE } from "./icons";

/** One icon from Cairn's device icon set. */
export function Glyph({
  type,
  size = 24,
  className,
}: {
  type: DeviceType | "building";
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      {ICON_PATHS[type].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
