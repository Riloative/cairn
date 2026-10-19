-- Saved connections: named Quick Connect targets (SSH, Telnet, Serial, RDP) that open
-- in one click without being inventory devices. `settings` holds the form as JSON and
-- never a secret; credentials come from an optional credential profile.
CREATE TABLE saved_connections (
    id            INTEGER PRIMARY KEY,
    name          TEXT NOT NULL,
    protocol      TEXT NOT NULL CHECK (protocol IN ('ssh', 'telnet', 'serial', 'rdp')),
    settings      TEXT NOT NULL,
    credential_id INTEGER REFERENCES credential_profiles(id) ON DELETE SET NULL,
    created_at    TEXT NOT NULL,
    last_used_at  TEXT
) STRICT;

CREATE UNIQUE INDEX saved_connections_name ON saved_connections (name COLLATE NOCASE);
