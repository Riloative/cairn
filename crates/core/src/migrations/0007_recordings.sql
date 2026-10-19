-- Session recordings (M8): asciicast v2 events stored encrypted in the database, in
-- chunks appended while the session runs. The asciicast header is built from the
-- recording's row when it is read or exported.

ALTER TABLE devices ADD COLUMN record_sessions INTEGER NOT NULL DEFAULT 0
    CHECK (record_sessions IN (0, 1));

CREATE TABLE recordings (
    id          INTEGER PRIMARY KEY,
    session_id  TEXT    NOT NULL,
    protocol    TEXT    NOT NULL,
    target      TEXT    NOT NULL,
    device_id   INTEGER REFERENCES devices(id) ON DELETE SET NULL,
    -- Hostname when recorded; kept when the device is deleted or renamed.
    device      TEXT    NOT NULL DEFAULT '',
    cols        INTEGER NOT NULL,
    rows        INTEGER NOT NULL,
    started_at  TEXT    NOT NULL,
    ended_at    TEXT,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    -- Size of the stored events.
    bytes       INTEGER NOT NULL DEFAULT 0,
    -- Output was dropped (size limit, or too much buffered while locked).
    truncated   INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1))
) STRICT;

CREATE INDEX recordings_started ON recordings (started_at);
CREATE INDEX recordings_device ON recordings (device_id);

CREATE TABLE recording_chunks (
    recording_id INTEGER NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    seq          INTEGER NOT NULL,
    -- asciicast v2 event lines (newline-delimited JSON).
    data         BLOB    NOT NULL,
    PRIMARY KEY (recording_id, seq)
) STRICT;
