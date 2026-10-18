import type {
  CredentialInput,
  CredentialProfile,
  Device,
  Interface,
  InventorySnapshot,
  LocationInput,
  SecretField,
  SecretUpdate,
} from "@/lib/ipc";

type Fail = (payload: { code: string; message: string; hint: string | null }) => never;

/** Simple stand-in for the Rust interface pattern expansion (trailing ranges only). */
export function expandPattern(pattern: string): string[] {
  const out: string[] = [];
  for (const part of pattern
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)) {
    const m = /^(.*?)(\d+)-(\d+)$/.exec(part);
    if (!m) {
      out.push(part);
      continue;
    }
    for (let n = Number(m[2]); n <= Number(m[3]); n++) out.push(`${m[1]}${n}`);
  }
  return out;
}

/**
 * In-memory inventory mirroring `cairn_core::inventory` closely enough for UI flows
 * (validation lives in Rust and is covered by Rust tests).
 */
export class FakeInventory {
  snap: InventorySnapshot = {
    sites: [{ id: 1, name: "Campus", notes: "" }],
    buildings: [],
    floors: [],
    rooms: [],
    racks: [],
    vendors: [
      "Cisco",
      "Juniper",
      "Fortinet",
      "Aruba",
      "HP",
      "Ubiquiti",
      "MikroTik",
      "Dell",
      "Generic",
    ],
    credentials: [],
    vlans: [],
    fields: [],
    devices: [],
    views: [],
  };
  interfaces: Interface[] = [];
  /** Secrets as the UI sent them (to assert what crossed IPC). */
  secrets = new Map<number, Partial<Record<SecretField, string>>>();
  private next = 100;

  constructor(
    private log: (kind: string, payload?: Record<string, unknown>) => void,
    private fail: Fail,
  ) {}

  private id() {
    return this.next++;
  }

  private upsert<T extends { id: number }>(list: T[], item: T): T {
    if (!item.id) {
      const created = { ...item, id: this.id() };
      list.push(created);
      return created;
    }
    const i = list.findIndex((x) => x.id === item.id);
    if (i < 0)
      this.fail({ code: "core.validation", message: "That item no longer exists.", hint: null });
    list[i] = item;
    return item;
  }

  private countInterfaces() {
    for (const d of this.snap.devices)
      d.interfaceCount = this.interfaces.filter((i) => i.deviceId === d.id).length;
  }

  saveDevice(device: Device) {
    if (!device.hostname.trim())
      this.fail({ code: "core.validation", message: "Enter a hostname.", hint: null });
    const saved = this.upsert(this.snap.devices, { ...device, updatedAt: "2026-01-01T00:00:00Z" });
    this.countInterfaces();
    const dup = this.snap.devices.filter(
      (d) => d.id !== saved.id && d.mgmtIp && d.mgmtIp === saved.mgmtIp,
    );
    this.log("inventory_changed", { entity: "device", name: saved.hostname });
    return {
      device: saved,
      warnings: dup.length
        ? [`${saved.mgmtIp} is also used by ${dup.map((d) => d.hostname).join(", ")}.`]
        : [],
    };
  }

  private applySecret(id: number, field: SecretField, u: SecretUpdate) {
    const s = { ...this.secrets.get(id) };
    if (u.action === "set") s[field] = u.value;
    this.secrets.set(
      id,
      u.action === "clear" ? Object.fromEntries(Object.entries(s).filter(([k]) => k !== field)) : s,
    );
  }

  saveCredential(input: CredentialInput): CredentialProfile {
    const existing = this.snap.credentials.find((c) => c.id === input.id);
    const id = existing?.id ?? this.id();
    for (const f of ["password", "keyData", "keyPassphrase", "enableSecret"] as const)
      this.applySecret(id, f, input[f]);
    const s = this.secrets.get(id) ?? {};
    const profile: CredentialProfile = {
      id,
      name: input.name,
      username: input.username,
      keyPath: input.keyPath,
      autoEnable: input.autoEnable,
      notes: input.notes,
      hasPassword: s.password !== undefined,
      hasKeyData: s.keyData !== undefined,
      hasKeyPassphrase: s.keyPassphrase !== undefined,
      hasEnableSecret: s.enableSecret !== undefined,
    };
    if (existing) Object.assign(existing, profile);
    else this.snap.credentials.push(profile);
    return profile;
  }

  handle(cmd: string, args: Record<string, unknown>): { handled: boolean; result?: unknown } {
    const s = this.snap;
    const done = (result: unknown = null) => ({ handled: true, result });
    switch (cmd) {
      case "inventory_snapshot":
        return done(structuredClone(s));
      case "location_save": {
        const { kind, ...loc } = args.location as LocationInput;
        const list = {
          site: s.sites,
          building: s.buildings,
          floor: s.floors,
          room: s.rooms,
          rack: s.racks,
        }[kind] as { id: number }[];
        return done({ kind, ...this.upsert(list, loc as { id: number }) });
      }
      case "location_delete": {
        const kind = args.kind as LocationInput["kind"];
        const id = Number(args.id);
        if (kind === "building") {
          s.buildings = s.buildings.filter((b) => b.id !== id);
          const floors = s.floors.filter((f) => f.buildingId === id).map((f) => f.id);
          s.floors = s.floors.filter((f) => f.buildingId !== id);
          s.racks = s.racks.filter((r) => !floors.includes(r.floorId));
          s.rooms = s.rooms.filter((r) => !floors.includes(r.floorId));
        } else if (kind === "floor") s.floors = s.floors.filter((f) => f.id !== id);
        else if (kind === "room") s.rooms = s.rooms.filter((r) => r.id !== id);
        else if (kind === "rack") s.racks = s.racks.filter((r) => r.id !== id);
        else s.sites = s.sites.filter((x) => x.id !== id);
        return done();
      }
      case "vendor_add": {
        const name = String(args.name);
        if (!s.vendors.some((v) => v.toLowerCase() === name.toLowerCase())) s.vendors.push(name);
        return done(name);
      }
      case "device_save":
        return done(this.saveDevice(args.device as Device));
      case "device_delete":
        s.devices = s.devices.filter((d) => d.id !== Number(args.id));
        this.interfaces = this.interfaces.filter((i) => i.deviceId !== Number(args.id));
        return done();
      case "device_duplicate": {
        const src = s.devices.find((d) => d.id === Number(args.id));
        if (!src) return this.fail({ code: "core.validation", message: "Gone", hint: null });
        const result = this.saveDevice({
          ...src,
          id: 0,
          hostname: `${src.hostname}-copy`,
          mgmtIp: "",
        });
        for (const i of this.interfaces.filter((x) => x.deviceId === src.id))
          this.interfaces.push({ ...i, id: this.id(), deviceId: result.device.id });
        this.countInterfaces();
        return done(result);
      }
      case "interfaces_list":
        return done(this.interfaces.filter((i) => i.deviceId === Number(args.deviceId)));
      case "interface_save": {
        const saved = this.upsert(this.interfaces, args.interface as Interface);
        this.countInterfaces();
        return done(saved);
      }
      case "interfaces_expand":
        return done(expandPattern(String(args.pattern)));
      case "interfaces_bulk_create": {
        const deviceId = Number(args.deviceId);
        const existing = this.interfaces.filter((i) => i.deviceId === deviceId).map((i) => i.name);
        const created: Interface[] = [];
        const skipped: string[] = [];
        for (const name of expandPattern(String(args.pattern))) {
          if (existing.includes(name)) {
            skipped.push(name);
            continue;
          }
          const iface = { ...(args.template as Interface), id: this.id(), deviceId, name };
          this.interfaces.push(iface);
          created.push(iface);
        }
        this.countInterfaces();
        return done({ created, skipped });
      }
      case "interfaces_delete": {
        const ids = args.ids as number[];
        const before = this.interfaces.length;
        this.interfaces = this.interfaces.filter((i) => !ids.includes(i.id));
        this.countInterfaces();
        return done(before - this.interfaces.length);
      }
      case "vlan_save":
        return done(this.upsert(s.vlans, args.vlan as InventorySnapshot["vlans"][number]));
      case "vlan_delete":
        s.vlans = s.vlans.filter((v) => v.id !== Number(args.id));
        return done();
      case "field_save": {
        const f = args.field as InventorySnapshot["fields"][number];
        const key = f.key || f.label.toLowerCase().replace(/[^a-z0-9]+/g, "_");
        return done(this.upsert(s.fields, { ...f, key }));
      }
      case "field_delete":
        s.fields = s.fields.filter((f) => f.id !== Number(args.id));
        return done();
      case "view_save":
        return done(this.upsert(s.views, args.view as InventorySnapshot["views"][number]));
      case "view_delete":
        s.views = s.views.filter((v) => v.id !== Number(args.id));
        return done();
      case "credential_save":
        return done(this.saveCredential(args.credential as CredentialInput));
      case "credential_delete":
        s.credentials = s.credentials.filter((c) => c.id !== Number(args.id));
        this.secrets.delete(Number(args.id));
        return done();
      case "credential_reveal": {
        const v = this.secrets.get(Number(args.id))?.[args.field as SecretField];
        if (v === undefined)
          return this.fail({ code: "core.validation", message: "Not set", hint: null });
        this.log("credential_revealed", { field: args.field });
        return done(v);
      }
      case "credential_copy":
        this.log("credential_copied", { field: args.field });
        return done();
      default:
        return { handled: false };
    }
  }
}
