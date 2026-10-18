import type { DeviceType } from "@/lib/ipc";

/**
 * Cairn's own device icon set: 24×24, stroke-only paths (round caps/joins), drawn in
 * `currentColor` so they follow the theme. Shared by the canvas and the SVG exporter.
 */
export const ICON_PATHS: Record<DeviceType | "building", readonly string[]> = {
  switch: [
    "M4 8h16a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z",
    "M6.5 12v1.2",
    "M9.5 12v1.2",
    "M12.5 12v1.2",
    "M15.5 12v1.2",
    "M18 11.2h.01",
  ],
  router: [
    "M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16z",
    "M9 9.5l3-3 3 3",
    "M12 6.5v4",
    "M9 14.5l3 3 3-3",
    "M12 17.5v-4",
  ],
  firewall: ["M4 6h16v12H4z", "M4 10h16", "M4 14h16", "M10 6v4", "M15 10v4", "M9 14v4"],
  server: ["M5 4h14v7H5z", "M5 13h14v7H5z", "M8 7.5h4", "M8 16.5h4", "M16 7.5h.01", "M16 16.5h.01"],
  "access-point": [
    "M5 17h14a1 1 0 0 1 0 2H5a1 1 0 0 1 0-2z",
    "M8.5 13.5a5 5 0 0 1 7 0",
    "M6 10.5a8.5 8.5 0 0 1 12 0",
  ],
  "wireless-controller": [
    "M4 13h16v6H4z",
    "M7 16h3",
    "M16 16h.01",
    "M8.5 9.5a5 5 0 0 1 7 0",
    "M10.6 11.2a2 2 0 0 1 2.8 0",
  ],
  storage: [
    "M5 6c0-1.7 3.1-3 7-3s7 1.3 7 3-3.1 3-7 3-7-1.3-7-3z",
    "M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6",
    "M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3",
  ],
  hypervisor: ["M3 5h18v14H3z", "M6 9h4v6H6z", "M14 9h4v6h-4z", "M3 8h18"],
  pdu: ["M9 3h6v18H9z", "M11 7h2", "M11 11h2", "M11 15h2", "M12 19v.01"],
  ups: ["M4 7h14v10H4z", "M18 10h2v4h-2", "M11.5 8.5l-2.5 4h3.5l-2.5 4"],
  "patch-panel": [
    "M3 8h18v8H3z",
    "M6 11h1",
    "M9.5 11h1",
    "M13 11h1",
    "M16.5 11h1",
    "M6 13.5h1",
    "M9.5 13.5h1",
    "M13 13.5h1",
    "M16.5 13.5h1",
  ],
  camera: ["M4 8h11v8H4z", "M15 11l5-3v8l-5-3", "M7 11h.01"],
  "ip-phone": [
    "M5 9h14v11H5z",
    "M7 9V6a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v3",
    "M9 13h.01",
    "M12 13h.01",
    "M15 13h.01",
    "M9 16.5h.01",
    "M12 16.5h.01",
    "M15 16.5h.01",
  ],
  generic: ["M12 3l8 4.5v9L12 21l-8-4.5v-9z", "M4 7.5l8 4.5 8-4.5", "M12 12v9"],
  building: [
    "M4 21V5l8-3 8 3v16",
    "M2.5 21h19",
    "M10 21v-4h4v4",
    "M8 8h.01",
    "M12 8h.01",
    "M16 8h.01",
    "M8 12h.01",
    "M12 12h.01",
    "M16 12h.01",
  ],
};

export const ICON_STROKE = 1.6;
