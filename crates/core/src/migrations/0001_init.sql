-- Cairn schema v1: settings and the tamper-evident audit log.

CREATE TABLE settings (
    key   TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
) STRICT;

CREATE TABLE audit_log (
    seq       INTEGER PRIMARY KEY NOT NULL,
    ts        TEXT    NOT NULL,
    kind      TEXT    NOT NULL,
    payload   TEXT    NOT NULL,
    prev_hash TEXT    NOT NULL,
    hash      TEXT    NOT NULL UNIQUE
) STRICT;

CREATE INDEX audit_log_ts ON audit_log (ts);
CREATE INDEX audit_log_kind ON audit_log (kind);

-- The audit log is append-only: refuse edits and deletes at the database level.
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN
    SELECT RAISE(ABORT, 'audit log is append-only');
END;

CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN
    SELECT RAISE(ABORT, 'audit log is append-only');
END;
