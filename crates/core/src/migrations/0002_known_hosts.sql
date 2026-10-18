-- Cairn schema v2: Cairn's own SSH known-hosts store.

CREATE TABLE known_hosts (
    host        TEXT    NOT NULL,
    port        INTEGER NOT NULL,
    key_type    TEXT    NOT NULL,
    fingerprint TEXT    NOT NULL,
    public_key  TEXT    NOT NULL,
    first_seen  TEXT    NOT NULL,
    last_seen   TEXT    NOT NULL,
    PRIMARY KEY (host, port, key_type)
) STRICT;
