import {
  BatteryCharging,
  Box,
  Boxes,
  Cable,
  Cctv,
  HardDrive,
  Network,
  Phone,
  PlugZap,
  RadioTower,
  Router,
  Server,
  Shield,
  Wifi,
  type LucideIcon,
} from "lucide-react";
import type { DeviceType } from "@/lib/ipc";

const ICONS: Record<DeviceType, LucideIcon> = {
  switch: Network,
  router: Router,
  firewall: Shield,
  server: Server,
  "access-point": Wifi,
  "wireless-controller": RadioTower,
  storage: HardDrive,
  hypervisor: Boxes,
  pdu: PlugZap,
  ups: BatteryCharging,
  "patch-panel": Cable,
  camera: Cctv,
  "ip-phone": Phone,
  generic: Box,
};

export function DeviceTypeIcon({ type, size = 16 }: { type: DeviceType; size?: number }) {
  const Icon = ICONS[type];
  return <Icon size={size} aria-hidden />;
}
