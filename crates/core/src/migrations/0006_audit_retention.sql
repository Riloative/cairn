-- Audit retention (M8). Old entries may be pruned, but only below an anchor that
-- records where the kept chain starts and the hash it continues from. The anchor can
-- only move forward, and each prune is itself an entry in the chain (`audit_pruned`),
-- so verification can tell a retention prune from a tampered head.

CREATE TABLE audit_anchor (
    id        INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
    keep_from INTEGER NOT NULL,
    prev_hash TEXT    NOT NULL
) STRICT;

CREATE TRIGGER audit_anchor_forward_only BEFORE UPDATE ON audit_anchor
WHEN NEW.keep_from < OLD.keep_from
BEGIN
    SELECT RAISE(ABORT, 'the audit anchor only moves forward');
END;

CREATE TRIGGER audit_anchor_no_delete BEFORE DELETE ON audit_anchor
BEGIN
    SELECT RAISE(ABORT, 'the audit anchor cannot be removed');
END;

DROP TRIGGER audit_log_no_delete;

CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
WHEN OLD.seq >= COALESCE((SELECT keep_from FROM audit_anchor WHERE id = 1), 1)
BEGIN
    SELECT RAISE(ABORT, 'audit log is append-only');
END;
