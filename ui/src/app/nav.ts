import {
  Activity,
  Map as MapIcon,
  Server,
  Settings,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import type { View } from "@/stores/ui";

export interface NavItem {
  view: View;
  label: string;
  icon: LucideIcon;
  shortcut: string;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { view: "sessions", label: "Sessions", icon: Activity, shortcut: "Mod+1" },
  { view: "inventory", label: "Inventory", icon: Server, shortcut: "Mod+2" },
  { view: "map", label: "Map", icon: MapIcon, shortcut: "Mod+3" },
  { view: "audit", label: "Audit", icon: ShieldCheck, shortcut: "Mod+4" },
  { view: "settings", label: "Settings", icon: Settings, shortcut: "Mod+," },
];
