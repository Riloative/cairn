import { Bookmark, Cable, Monitor, Network, Plus, Terminal, TerminalSquare } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { openSaved } from "@/connect/saved";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/Menu";
import { Tooltip } from "@/components/ui/Tooltip";
import { useActions } from "@/lib/actions";
import { useSavedConnections } from "@/stores/savedConnections";
import { useUi, type ConnectProtocol } from "@/stores/ui";
import { openLocalShell } from "@/terminal/controller";

const PROTOCOLS: { protocol: ConnectProtocol; label: string; icon: typeof Terminal }[] = [
  { protocol: "ssh", label: "SSH…", icon: Network },
  { protocol: "telnet", label: "Telnet…", icon: TerminalSquare },
  { protocol: "serial", label: "Serial console…", icon: Cable },
  { protocol: "rdp", label: "Remote desktop (RDP)…", icon: Monitor },
];

/** At most this many saved connections in the menu; the rest are in the sidebar. */
const SAVED_IN_MENU = 8;

/**
 * The "+" in the tab bar: start a local shell, a container shell, a connection by
 * protocol, or a saved connection, all with the mouse.
 */
export function NewSessionMenu() {
  const saved = useSavedConnections((s) => s.list) ?? [];
  const containers = useActions(
    useShallow((s) => [...s.actions.values()].filter((a) => a.group === "Containers")),
  );
  const openConnect = useUi((s) => s.openConnect);
  const setView = useUi((s) => s.setView);

  return (
    <DropdownMenu>
      <Tooltip label="New session">
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="New session"
            className="mb-1 rounded-md p-1.5 text-fg-subtle hover:bg-surface-raised hover:text-fg data-[state=open]:bg-surface-raised data-[state=open]:text-fg"
          >
            <Plus size={14} />
          </button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuItem
          icon={<Terminal size={14} />}
          shortcut="Mod+T"
          onSelect={() => {
            setView("sessions");
            void openLocalShell();
          }}
        >
          Local shell
        </DropdownMenuItem>
        {containers.map((a) => (
          <DropdownMenuItem key={a.id} icon={<Terminal size={14} />} onSelect={() => a.run()}>
            {a.title}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        {PROTOCOLS.map(({ protocol, label, icon: Icon }) => (
          <DropdownMenuItem
            key={protocol}
            icon={<Icon size={14} />}
            shortcut={protocol === "ssh" ? "Mod+N" : undefined}
            onSelect={() => openConnect(protocol)}
          >
            {label}
          </DropdownMenuItem>
        ))}
        {saved.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <p className="px-2 pt-1 pb-0.5 text-[11px] font-medium tracking-wide text-fg-subtle uppercase">
              Saved
            </p>
            {saved.slice(0, SAVED_IN_MENU).map((s) => (
              <DropdownMenuItem
                key={s.id}
                icon={<Bookmark size={14} />}
                onSelect={() => void openSaved(s)}
              >
                {s.name}
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
