-- Indexes on the payload fields the audit view filters on (M9 performance pass). Each
-- matches one lookup in `audit::filter_sql` exactly (expression and collation), so a
-- device or protocol filter reads only the matching entries instead of every payload.

CREATE INDEX audit_log_session ON audit_log (json_extract(payload, '$.sessionId'))
    WHERE json_extract(payload, '$.sessionId') IS NOT NULL;
CREATE INDEX audit_log_device ON audit_log (json_extract(payload, '$.device') COLLATE NOCASE)
    WHERE json_extract(payload, '$.device') IS NOT NULL;
CREATE INDEX audit_log_protocol ON audit_log (json_extract(payload, '$.protocol') COLLATE NOCASE)
    WHERE json_extract(payload, '$.protocol') IS NOT NULL;
CREATE INDEX audit_log_inventory_name ON audit_log (
    json_extract(payload, '$.entity'),
    json_extract(payload, '$.name') COLLATE NOCASE
) WHERE kind = 'inventory_changed';
