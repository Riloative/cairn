-- Cairn schema v5: power tools (snippets, port-forward presets, config snapshots).

-- Saved commands. `folder` is a "/"-separated path ("" = top level); `vendor` limits a
-- snippet to devices of that vendor ("" = any). Variables are written {{name}} or
-- {{name:default}} in `body`.
CREATE TABLE snippets (
    id          INTEGER PRIMARY KEY,
    name        TEXT    NOT NULL,
    folder      TEXT    NOT NULL DEFAULT '',
    vendor      TEXT    NOT NULL DEFAULT '',
    body        TEXT    NOT NULL,
    description TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL,
    UNIQUE (folder, name)
) STRICT;

-- Port forwards a device starts with (when `auto_start`) or offers in the manager.
CREATE TABLE forward_presets (
    id          INTEGER PRIMARY KEY,
    device_id   INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    kind        TEXT    NOT NULL CHECK (kind IN ('local', 'remote', 'dynamic')),
    bind_host   TEXT    NOT NULL,
    bind_port   INTEGER NOT NULL CHECK (bind_port BETWEEN 0 AND 65535),
    dest_host   TEXT    NOT NULL DEFAULT '',
    dest_port   INTEGER NOT NULL DEFAULT 0 CHECK (dest_port BETWEEN 0 AND 65535),
    auto_start  INTEGER NOT NULL DEFAULT 0,
    description TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
) STRICT;

CREATE INDEX forward_presets_device ON forward_presets (device_id);

-- Configuration snapshots grabbed from devices (manual only).
CREATE TABLE config_snapshots (
    id          INTEGER PRIMARY KEY,
    device_id   INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    taken_at    TEXT    NOT NULL,
    command     TEXT    NOT NULL,
    content     TEXT    NOT NULL,
    sha256      TEXT    NOT NULL,
    note        TEXT    NOT NULL DEFAULT ''
) STRICT;

CREATE INDEX config_snapshots_device ON config_snapshots (device_id, taken_at);

-- A few starters; users edit or delete them like their own.
INSERT INTO snippets (name, folder, vendor, body, description, created_at, updated_at) VALUES
  ('Interface status', 'Cisco', 'Cisco', 'show interfaces status', '',
   strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('Describe interface', 'Cisco', 'Cisco',
   'configure terminal
interface {{interface}}
 description {{description}}
end', 'Sets an interface description.',
   strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('Access VLAN', 'Cisco', 'Cisco',
   'configure terminal
interface {{interface}}
 switchport mode access
 switchport access vlan {{vlan}}
end', '',
   strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('Save configuration', 'Cisco', 'Cisco', 'copy running-config startup-config', '',
   strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('Interface terse', 'Juniper', 'Juniper', 'show interfaces terse {{interface:}}', '',
   strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('MAC address table', 'Aruba', 'Aruba', 'show mac-address-table', '',
   strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('Ping from device', '', '', 'ping {{target}}', '',
   strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));
