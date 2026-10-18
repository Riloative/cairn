-- Cairn schema v3: inventory (locations, devices, interfaces, VLANs, credential
-- profiles, custom fields, saved table views).
--
-- Flexible per-device data (connection methods, tags, custom field values, VLAN ids)
-- is JSON text validated in Rust. Timestamps are RFC 3339 UTC strings.

CREATE TABLE sites (
    id          INTEGER PRIMARY KEY,
    name        TEXT    NOT NULL UNIQUE,
    notes       TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
) STRICT;

-- The site layer may stay implicit in the UI; there is always at least one.
INSERT INTO sites (id, name, created_at, updated_at)
VALUES (1, 'Campus', strftime('%Y-%m-%dT%H:%M:%fZ'), strftime('%Y-%m-%dT%H:%M:%fZ'));

CREATE TABLE buildings (
    id          INTEGER PRIMARY KEY,
    site_id     INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    name        TEXT    NOT NULL,
    code        TEXT    NOT NULL DEFAULT '',
    address     TEXT    NOT NULL DEFAULT '',
    notes       TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL,
    UNIQUE (site_id, name)
) STRICT;

CREATE TABLE floors (
    id          INTEGER PRIMARY KEY,
    building_id INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
    name        TEXT    NOT NULL,
    level       INTEGER NOT NULL DEFAULT 0,
    notes       TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL,
    UNIQUE (building_id, name)
) STRICT;

CREATE TABLE rooms (
    id          INTEGER PRIMARY KEY,
    floor_id    INTEGER NOT NULL REFERENCES floors(id) ON DELETE CASCADE,
    name        TEXT    NOT NULL,
    notes       TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL,
    UNIQUE (floor_id, name)
) STRICT;

CREATE TABLE racks (
    id          INTEGER PRIMARY KEY,
    floor_id    INTEGER NOT NULL REFERENCES floors(id) ON DELETE CASCADE,
    room_id     INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
    name        TEXT    NOT NULL,
    height_u    INTEGER NOT NULL DEFAULT 42 CHECK (height_u BETWEEN 1 AND 60),
    notes       TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL,
    UNIQUE (floor_id, name)
) STRICT;

-- Vendors added by the user (built-in vendors are constants in code).
CREATE TABLE vendors (
    name        TEXT    PRIMARY KEY
) STRICT;

CREATE TABLE credential_profiles (
    id          INTEGER PRIMARY KEY,
    name        TEXT    NOT NULL UNIQUE,
    username    TEXT    NOT NULL DEFAULT '',
    -- Path to a private key file on this machine (the key itself may instead be stored
    -- in credential_secrets.key_data).
    key_path    TEXT,
    auto_enable INTEGER NOT NULL DEFAULT 0,
    notes       TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
) STRICT;

-- Secrets live only here (inside the encrypted database) and in Rust memory.
CREATE TABLE credential_secrets (
    profile_id      INTEGER PRIMARY KEY REFERENCES credential_profiles(id) ON DELETE CASCADE,
    password        TEXT,
    key_data        TEXT,
    key_passphrase  TEXT,
    enable_secret   TEXT
) STRICT;

CREATE TABLE vlans (
    id          INTEGER PRIMARY KEY,
    vid         INTEGER NOT NULL UNIQUE CHECK (vid BETWEEN 1 AND 4094),
    name        TEXT    NOT NULL DEFAULT '',
    subnet      TEXT    NOT NULL DEFAULT '',
    gateway     TEXT    NOT NULL DEFAULT '',
    description TEXT    NOT NULL DEFAULT '',
    color       TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
) STRICT;

CREATE TABLE custom_fields (
    id          INTEGER PRIMARY KEY,
    key         TEXT    NOT NULL UNIQUE,
    label       TEXT    NOT NULL,
    kind        TEXT    NOT NULL,
    options     TEXT    NOT NULL DEFAULT '[]',
    position    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
) STRICT;

CREATE TABLE devices (
    id              INTEGER PRIMARY KEY,
    hostname        TEXT    NOT NULL,
    mgmt_ip         TEXT    NOT NULL DEFAULT '',
    device_type     TEXT    NOT NULL DEFAULT 'generic',
    vendor          TEXT    NOT NULL DEFAULT 'generic',
    model           TEXT    NOT NULL DEFAULT '',
    serial          TEXT    NOT NULL DEFAULT '',
    firmware        TEXT    NOT NULL DEFAULT '',
    building_id     INTEGER REFERENCES buildings(id) ON DELETE SET NULL,
    floor_id        INTEGER REFERENCES floors(id) ON DELETE SET NULL,
    room_id         INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
    rack_id         INTEGER REFERENCES racks(id) ON DELETE SET NULL,
    rack_u          INTEGER,
    u_height        INTEGER NOT NULL DEFAULT 1 CHECK (u_height BETWEEN 1 AND 60),
    credential_id   INTEGER REFERENCES credential_profiles(id) ON DELETE SET NULL,
    connections     TEXT    NOT NULL DEFAULT '[]',
    vlans           TEXT    NOT NULL DEFAULT '[]',
    tags            TEXT    NOT NULL DEFAULT '[]',
    notes           TEXT    NOT NULL DEFAULT '',
    custom          TEXT    NOT NULL DEFAULT '{}',
    created_at      TEXT    NOT NULL,
    updated_at      TEXT    NOT NULL
) STRICT;

CREATE INDEX devices_hostname ON devices (hostname COLLATE NOCASE);
CREATE INDEX devices_mgmt_ip ON devices (mgmt_ip);
CREATE INDEX devices_rack ON devices (rack_id);

CREATE TABLE interfaces (
    id              INTEGER PRIMARY KEY,
    device_id       INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    name            TEXT    NOT NULL,
    kind            TEXT    NOT NULL DEFAULT 'copper',
    speed           TEXT    NOT NULL DEFAULT '',
    mode            TEXT    NOT NULL DEFAULT 'access',
    access_vlan     INTEGER,
    native_vlan     INTEGER,
    allowed_vlans   TEXT    NOT NULL DEFAULT '',
    lag             TEXT    NOT NULL DEFAULT '',
    description     TEXT    NOT NULL DEFAULT '',
    enabled         INTEGER NOT NULL DEFAULT 1,
    position        INTEGER NOT NULL DEFAULT 0,
    UNIQUE (device_id, name)
) STRICT;

CREATE TABLE saved_views (
    id          INTEGER PRIMARY KEY,
    name        TEXT    NOT NULL UNIQUE,
    state       TEXT    NOT NULL,
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
) STRICT;
