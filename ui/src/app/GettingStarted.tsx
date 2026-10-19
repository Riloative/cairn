import { ArchiveRestore, Keyboard, Plug, Server, X } from "lucide-react";
import type { ReactNode } from "react";
import { Shortcut } from "@/components/ui/Kbd";
import { useDataDialog } from "@/stores/backupUi";
import { useInventory } from "@/stores/inventory";
import { useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";

function Step({
  icon,
  title,
  text,
  keys,
  done,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  text: string;
  keys?: string;
  done?: boolean;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="flex w-full items-start gap-3 rounded-lg p-3 text-left transition-colors duration-150 hover:bg-surface-raised"
      >
        <span className="mt-0.5 text-fg-muted">{icon}</span>
        <span className="flex-1">
          <span className="flex items-center gap-2 font-medium">
            {title}
            {done && <span className="text-xs font-normal text-success">done</span>}
          </span>
          <span className="block text-xs text-fg-muted">{text}</span>
        </span>
        {keys && <Shortcut keys={keys} />}
      </button>
    </li>
  );
}

/** First-run guide under the empty Sessions view, until dismissed. */
export function GettingStarted() {
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const devices = useInventory((s) => s.snapshot?.devices.length ?? 0);
  if (!settings || settings.onboardingDone) return null;
  const ui = useUi.getState();
  return (
    <section
      aria-labelledby="getting-started"
      className="mx-auto mt-2 w-full max-w-lg rounded-xl border border-border bg-surface p-4 animate-fade-in"
    >
      <div className="mb-1 flex items-center">
        <h2 id="getting-started" className="flex-1 px-3 text-[13px] font-semibold">
          Get started
        </h2>
        <button
          type="button"
          aria-label="Hide getting started"
          onClick={() => void update({ onboardingDone: true })}
          className="rounded-md p-1 text-fg-subtle hover:bg-surface-raised hover:text-fg"
        >
          <X size={14} />
        </button>
      </div>
      <ul>
        <Step
          icon={<Plug size={16} />}
          title="Connect to a device"
          text="SSH, Telnet, serial console or RDP, by address."
          keys="Mod+N"
          onClick={() => ui.openConnect("ssh")}
        />
        <Step
          icon={<Server size={16} />}
          title="Build your inventory"
          text="Devices with their credentials, locations and links connect with one click and draw the map."
          done={devices > 0}
          onClick={() => ui.setView("inventory")}
        />
        <Step
          icon={<ArchiveRestore size={16} />}
          title="Make a backup"
          text="An encrypted copy with its own password, in case the master password is lost."
          onClick={() => useDataDialog.getState().set("backup")}
        />
        <Step
          icon={<Keyboard size={16} />}
          title="Learn the shortcuts"
          text="Everything is in the command palette too."
          keys="Mod+/"
          onClick={() => ui.setShortcutsOpen(true)}
        />
      </ul>
    </section>
  );
}
