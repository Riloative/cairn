-- Cairn schema v4: network map (links, node positions, zones, floor plans).

-- Interface-to-interface links. An interface takes part in at most one link (checked
-- in Rust, since it may be either end).
CREATE TABLE links (
    id              INTEGER PRIMARY KEY,
    a_interface_id  INTEGER NOT NULL REFERENCES interfaces(id) ON DELETE CASCADE,
    b_interface_id  INTEGER NOT NULL REFERENCES interfaces(id) ON DELETE CASCADE,
    media           TEXT    NOT NULL DEFAULT 'copper',
    speed           TEXT    NOT NULL DEFAULT '',
    vlans           TEXT    NOT NULL DEFAULT '',
    lag             TEXT    NOT NULL DEFAULT '',
    description     TEXT    NOT NULL DEFAULT '',
    -- Per-link label overrides: {"ports": bool|null, "speed": bool|null, "vlans": bool|null}.
    labels          TEXT    NOT NULL DEFAULT '{}',
    created_at      TEXT    NOT NULL,
    updated_at      TEXT    NOT NULL,
    CHECK (a_interface_id != b_interface_id)
) STRICT;

CREATE INDEX links_a ON links (a_interface_id);
CREATE INDEX links_b ON links (b_interface_id);

-- Node positions per map view ("campus:1", "building:3", "floor:5"). Node keys are
-- "d:<device id>" or "b:<building id>".
CREATE TABLE map_positions (
    view    TEXT    NOT NULL,
    node    TEXT    NOT NULL,
    x       REAL    NOT NULL,
    y       REAL    NOT NULL,
    locked  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (view, node)
) STRICT;

-- Named rectangles grouping nodes on a view ("DMZ", "Core").
CREATE TABLE map_zones (
    id          INTEGER PRIMARY KEY,
    view        TEXT    NOT NULL,
    name        TEXT    NOT NULL,
    color       TEXT    NOT NULL DEFAULT '',
    x           REAL    NOT NULL,
    y           REAL    NOT NULL,
    width       REAL    NOT NULL,
    height      REAL    NOT NULL,
    locked      INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
) STRICT;

CREATE INDEX map_zones_view ON map_zones (view);

-- One background image per floor (PDFs are rendered to PNG when imported).
CREATE TABLE floor_plans (
    floor_id    INTEGER PRIMARY KEY REFERENCES floors(id) ON DELETE CASCADE,
    name        TEXT    NOT NULL,
    mime        TEXT    NOT NULL,
    data        BLOB    NOT NULL,
    width       INTEGER NOT NULL,
    height      INTEGER NOT NULL,
    scale       REAL    NOT NULL DEFAULT 1,
    opacity     REAL    NOT NULL DEFAULT 0.6,
    x           REAL    NOT NULL DEFAULT 0,
    y           REAL    NOT NULL DEFAULT 0,
    updated_at  TEXT    NOT NULL
) STRICT;
