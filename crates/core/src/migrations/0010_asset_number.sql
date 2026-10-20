-- Asset number (inventory tag) for devices.
ALTER TABLE devices ADD COLUMN asset_number TEXT NOT NULL DEFAULT '';
