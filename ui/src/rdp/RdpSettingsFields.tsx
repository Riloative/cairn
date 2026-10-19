import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { NativeSelect } from "@/components/ui/NativeSelect";
import { Switch } from "@/components/ui/Switch";
import type { RdpSecurity } from "@/lib/ipc";

/** The RDP settings shared by device connections and quick connect. */
export interface RdpSettings {
  domain: string;
  security: RdpSecurity;
  /** 0×0 follows the window. */
  width: number;
  height: number;
  colorDepth: 16 | 32;
  clipboard: boolean;
  tunnel: string;
}

const PRESETS = [
  [1280, 720],
  [1366, 768],
  [1600, 900],
  [1920, 1080],
  [2560, 1440],
] as const;

function sizeValue(s: RdpSettings): string {
  return s.width === 0 ? "fit" : `${s.width}x${s.height}`;
}

export function RdpSettingsFields<T extends RdpSettings>({
  value,
  set,
}: {
  value: T;
  set: (v: T) => void;
}) {
  const current = sizeValue(value);
  const known = current === "fit" || PRESETS.some(([w, h]) => `${w}x${h}` === current);
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Domain" description="Or DOMAIN\user in the username.">
          <Input
            spellCheck={false}
            value={value.domain}
            onChange={(e) => set({ ...value, domain: e.target.value })}
          />
        </Field>
        <Field label="Security">
          <NativeSelect
            value={value.security}
            onChange={(e) => set({ ...value, security: e.target.value as RdpSecurity })}
          >
            <option value="nla">NLA (recommended)</option>
            <option value="tls">TLS only (server logon screen)</option>
          </NativeSelect>
        </Field>
        <Field label="Resolution">
          <NativeSelect
            value={current}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "fit") set({ ...value, width: 0, height: 0 });
              else {
                const [w, h] = v.split("x").map(Number);
                set({ ...value, width: w ?? 0, height: h ?? 0 });
              }
            }}
          >
            <option value="fit">Fit the window</option>
            {PRESETS.map(([w, h]) => (
              <option key={`${w}x${h}`} value={`${w}x${h}`}>
                {w} × {h}
              </option>
            ))}
            {!known && <option value={current}>{current.replace("x", " × ")}</option>}
          </NativeSelect>
        </Field>
        <Field label="Colors">
          <NativeSelect
            value={String(value.colorDepth)}
            onChange={(e) => set({ ...value, colorDepth: e.target.value === "16" ? 16 : 32 })}
          >
            <option value="32">32-bit (best quality)</option>
            <option value="16">16-bit (slow links)</option>
          </NativeSelect>
        </Field>
      </div>
      <Field label="SSH tunnel" description="Optional jump host, e.g. ops@bastion:22.">
        <Input
          spellCheck={false}
          value={value.tunnel}
          onChange={(e) => set({ ...value, tunnel: e.target.value })}
        />
      </Field>
      <label className="flex items-center gap-2 text-[13px]">
        <Switch
          checked={value.clipboard}
          onCheckedChange={(clipboard) => set({ ...value, clipboard })}
          aria-label="Share the clipboard"
        />
        Share the clipboard (text)
      </label>
    </div>
  );
}
