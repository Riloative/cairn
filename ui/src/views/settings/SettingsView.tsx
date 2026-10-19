import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Shortcut } from "@/components/ui/Kbd";
import { Skeleton } from "@/components/ui/Skeleton";
import { Switch } from "@/components/ui/Switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { availableActions, useActions } from "@/lib/actions";
import { cn } from "@/lib/cn";
import { getAppInfo, isTauri, type AppInfo, type Settings } from "@/lib/ipc";
import {
  DARK_THEMES,
  LIGHT_THEMES,
  SYSTEM_SWATCH,
  THEMES,
  type ThemeId,
  type ThemeInfo,
} from "@/lib/theme";
import { confirmAction } from "@/stores/confirm";
import { useNotifications } from "@/stores/notifications";
import { useSettings } from "@/stores/settings";
import { BackupSettings } from "./BackupSettings";
import { Row } from "./Row";
import { ChangePasswordDialog } from "./ChangePasswordDialog";
import { KnownHosts } from "./KnownHosts";
import { TerminalSettings } from "./terminal/TerminalSettings";

const AUTO_LOCK_OPTIONS = [
  { value: 1, label: "1 minute" },
  { value: 5, label: "5 minutes" },
  { value: 15, label: "15 minutes" },
  { value: 30, label: "30 minutes" },
  { value: 60, label: "1 hour" },
  { value: 240, label: "4 hours" },
  { value: 0, label: "Never" },
] as const;

const RETENTION_OPTIONS = [
  { value: 0, label: "Keep everything" },
  { value: 90, label: "90 days" },
  { value: 180, label: "6 months" },
  { value: 365, label: "1 year" },
  { value: 730, label: "2 years" },
  { value: 1825, label: "5 years" },
] as const;

/** Ask before a retention change that removes entries now. */
async function changeRetention(
  current: number,
  next: number,
  update: (p: Partial<Settings>) => void,
) {
  const shorter = next !== 0 && (current === 0 || next < current);
  if (shorter) {
    const label = RETENTION_OPTIONS.find((o) => o.value === next)?.label ?? `${next} days`;
    const ok = await confirmAction({
      title: `Keep the audit log for ${label}?`,
      description:
        "Older entries are removed now and from then on each time Cairn unlocks. Removed entries cannot be recovered; export the audit log first if you need them. The integrity check still covers the kept entries.",
      confirmLabel: "Remove older entries",
      destructive: true,
    });
    if (!ok) return;
  }
  update({ auditRetentionDays: next });
}

function ThemeCard({
  theme,
  selected,
  onSelect,
}: {
  theme: ThemeInfo | { id: "system"; label: string };
  selected: boolean;
  onSelect: () => void;
}) {
  const swatch = "swatch" in theme ? theme.swatch : SYSTEM_SWATCH;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "flex flex-col gap-2 rounded-lg border p-2 text-left transition-colors duration-150",
        selected
          ? "border-accent ring-2 ring-accent/30"
          : "border-border hover:border-border-strong",
      )}
    >
      {/* Swatch colors are data (each theme's own palette), not UI styling. */}
      <div
        className="flex h-14 items-end gap-1 rounded-md p-2"
        style={{
          background:
            theme.id === "system"
              ? `linear-gradient(135deg, ${swatch[0]} 50%, ${swatch[1]} 50%)`
              : swatch[0],
        }}
      >
        <span className="h-4 w-10 rounded-sm" style={{ background: swatch[1] }} />
        <span className="h-4 w-4 rounded-sm" style={{ background: swatch[2] }} />
      </div>
      <span className="px-0.5 text-xs">{theme.label}</span>
    </button>
  );
}

function ThemeSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: ThemeId;
  options: readonly ThemeInfo[];
  onChange: (id: ThemeId) => void;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value as ThemeId)}
      className="h-8 rounded-md border border-border bg-surface px-2 text-[13px]"
    >
      {options.map((t) => (
        <option key={t.id} value={t.id}>
          {t.label}
        </option>
      ))}
    </select>
  );
}

function Appearance({ s, update }: { s: Settings; update: (p: Partial<Settings>) => void }) {
  return (
    <section>
      <div role="radiogroup" aria-label="Theme" className="grid grid-cols-4 gap-3 py-4">
        <ThemeCard
          theme={{ id: "system", label: "Follow system" }}
          selected={s.theme === "system"}
          onSelect={() => update({ theme: "system" })}
        />
        {THEMES.map((t) => (
          <ThemeCard
            key={t.id}
            theme={t}
            selected={s.theme === t.id}
            onSelect={() => update({ theme: t.id })}
          />
        ))}
      </div>
      {s.theme === "system" && (
        <>
          <Row title="Dark mode theme" description="Used when your system is in dark mode.">
            <ThemeSelect
              label="Dark mode theme"
              value={s.systemDarkTheme}
              options={DARK_THEMES}
              onChange={(id) => update({ systemDarkTheme: id })}
            />
          </Row>
          <Row title="Light mode theme" description="Used when your system is in light mode.">
            <ThemeSelect
              label="Light mode theme"
              value={s.systemLightTheme}
              options={LIGHT_THEMES}
              onChange={(id) => update({ systemLightTheme: id })}
            />
          </Row>
        </>
      )}
      <Row title="Reduce motion" description="Turn off animations and transitions.">
        <Switch
          aria-label="Reduce motion"
          checked={s.reduceMotion}
          onCheckedChange={(v) => update({ reduceMotion: v })}
        />
      </Row>
    </section>
  );
}

function Security({ s, update }: { s: Settings; update: (p: Partial<Settings>) => void }) {
  const [changing, setChanging] = useState(false);
  return (
    <section>
      <Row title="Auto-lock" description="Lock Cairn after this much time without input.">
        <select
          aria-label="Auto-lock"
          value={s.autoLockMinutes}
          onChange={(e) => update({ autoLockMinutes: Number(e.target.value) })}
          className="h-8 rounded-md border border-border bg-surface px-2 text-[13px]"
        >
          {AUTO_LOCK_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Row>
      <Row title="Lock on sleep" description="Lock when the computer sleeps or suspends.">
        <Switch
          aria-label="Lock on sleep"
          checked={s.lockOnSleep}
          onCheckedChange={(v) => update({ lockOnSleep: v })}
        />
      </Row>
      <Row
        title="Audit retention"
        description="Remove audit entries older than this when Cairn unlocks."
      >
        <select
          aria-label="Audit retention"
          value={s.auditRetentionDays}
          onChange={(e) =>
            void changeRetention(s.auditRetentionDays, Number(e.target.value), update)
          }
          className="h-8 rounded-md border border-border bg-surface px-2 text-[13px]"
        >
          {RETENTION_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
          {!RETENTION_OPTIONS.some((o) => o.value === s.auditRetentionDays) && (
            <option value={s.auditRetentionDays}>{s.auditRetentionDays} days</option>
          )}
        </select>
      </Row>
      <Row
        title="Master password"
        description="Re-encrypts the database. A lost master password cannot be recovered."
      >
        <Button onClick={() => setChanging(true)}>Change…</Button>
      </Row>
      <Row
        title="Use ~/.ssh/known_hosts"
        description="Trust host keys you already accepted in OpenSSH (read-only)."
      >
        <Switch
          aria-label="Use ~/.ssh/known_hosts"
          checked={s.readOpensshKnownHosts}
          onCheckedChange={(v) => update({ readOpensshKnownHosts: v })}
        />
      </Row>
      <Row
        title="Notify on disconnect"
        description="Desktop notification when a session in the background drops."
      >
        <Switch
          aria-label="Notify on disconnect"
          checked={s.notifyOnDisconnect}
          onCheckedChange={(v) => update({ notifyOnDisconnect: v })}
        />
      </Row>
      <Row
        title="Record sessions"
        description="Record every terminal session for replay (Audit → Recordings). Recordings are encrypted with your vault; typed input is not recorded. Devices can also be recorded one by one."
      >
        <Switch
          aria-label="Record sessions"
          checked={s.recordSessions}
          onCheckedChange={(v) => update({ recordSessions: v })}
        />
      </Row>
      <Row
        title="Session logging"
        description="Save raw session output with timestamps as plain, unencrypted text files in the logs folder of Cairn's data directory. Typed input is not logged."
      >
        <Switch
          aria-label="Session logging"
          checked={s.sessionLogging}
          onCheckedChange={(v) => update({ sessionLogging: v })}
        />
      </Row>
      <Row
        title="Long command notifications"
        description="With shell integration (OSC 133), notify when a background command runs longer than this."
      >
        <select
          aria-label="Long command notifications"
          value={s.longCommandNotifySecs}
          onChange={(e) => update({ longCommandNotifySecs: Number(e.target.value) })}
          className="h-8 rounded-md border border-border bg-surface px-2 text-[13px]"
        >
          {[0, 10, 30, 60, 300].map((v) => (
            <option key={v} value={v}>
              {v === 0 ? "Off" : v < 60 ? `${v} seconds` : `${v / 60} min`}
            </option>
          ))}
        </select>
      </Row>
      <div className="py-4">
        <p className="font-medium">Known hosts</p>
        <p className="mb-2 text-xs text-fg-muted">
          SSH host keys you trusted in Cairn. Forgetting one makes the next connection ask again.
        </p>
        <KnownHosts />
      </div>
      <ChangePasswordDialog open={changing} onOpenChange={setChanging} />
    </section>
  );
}

function Shortcuts() {
  const registry = useActions((s) => s.actions);
  const withShortcuts = availableActions(registry).flatMap((a) =>
    a.shortcut ? [{ ...a, shortcut: a.shortcut }] : [],
  );
  return (
    <section className="py-2">
      {withShortcuts.map((a) => (
        <div key={a.id} className="flex items-center border-b border-border py-2.5 last:border-0">
          <span className="flex-1">{a.title}</span>
          <span className="mr-6 text-xs text-fg-subtle">{a.group}</span>
          <Shortcut keys={a.shortcut} />
        </div>
      ))}
    </section>
  );
}

function About() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    if (isTauri()) void getAppInfo().then(setInfo);
  }, []);
  return (
    <section className="flex flex-col gap-2 py-4 text-fg-muted">
      <p>
        <span className="font-medium text-fg">Cairn</span>{" "}
        {info ? `${info.version} · ${info.os}/${info.arch}` : ""}
      </p>
      <p>Fully local. No telemetry; Cairn only connects where you tell it to.</p>
      <p>
        Fonts: Inter and JetBrains Mono, SIL Open Font License 1.1 (bundled under
        <span className="font-mono"> licenses/</span>).
      </p>
    </section>
  );
}

export function SettingsView() {
  const settings = useSettings((s) => s.settings);
  const updateSettings = useSettings((s) => s.update);
  const notifyError = useNotifications((s) => s.notifyError);

  const update = (patch: Partial<Settings>) =>
    void updateSettings(patch).catch((e: unknown) => notifyError(e, "Could not save settings"));

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-6">
        <h1 className="mb-4 text-[15px] font-semibold tracking-tight">Settings</h1>
        <Tabs defaultValue="appearance">
          <TabsList>
            <TabsTrigger value="appearance">Appearance</TabsTrigger>
            <TabsTrigger value="security">Security</TabsTrigger>
            <TabsTrigger value="terminal">Terminal</TabsTrigger>
            <TabsTrigger value="backup">Backup</TabsTrigger>
            <TabsTrigger value="shortcuts">Shortcuts</TabsTrigger>
            <TabsTrigger value="about">About</TabsTrigger>
          </TabsList>
          {settings === null ? (
            <div className="flex flex-col gap-3 py-4">
              <Skeleton className="h-20" />
              <Skeleton className="h-10" />
            </div>
          ) : (
            <>
              <TabsContent value="appearance">
                <Appearance s={settings} update={update} />
              </TabsContent>
              <TabsContent value="security">
                <Security s={settings} update={update} />
              </TabsContent>
            </>
          )}
          <TabsContent value="terminal">
            <TerminalSettings />
          </TabsContent>
          <TabsContent value="backup">
            <BackupSettings />
          </TabsContent>
          <TabsContent value="shortcuts">
            <Shortcuts />
          </TabsContent>
          <TabsContent value="about">
            <About />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
