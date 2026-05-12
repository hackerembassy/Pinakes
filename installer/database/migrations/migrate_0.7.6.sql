-- Pinakes v0.7.6 — Plugin registry repair: oai-pmh-server + viaf-authority
--
-- Finding F021 (adamsreview Phase 8):
-- The plugin-registration block at the end of migrate_0.7.4.sql (lines 395-493)
-- inserts the four NEW v0.7.x interoperability plugins
--   (ncip-server, openurl-resolver, bibframe-linked-data, resource-sync)
-- but OMITS two plugins that are part of BundledPlugins::LIST:
--   - oai-pmh-server  (originally registered by migrate_0.6.0.sql)
--   - viaf-authority  (originally registered by migrate_0.7.0.sql)
--
-- Installs that upgraded directly from a pre-0.6.0 / pre-0.7.0 schema (or that
-- had their plugins table truncated/rebuilt) and then jumped to 0.7.4 may be
-- missing rows for these two bundled plugins, even though the plugin code is
-- shipped in the release. This migration is idempotent (ON DUPLICATE KEY UPDATE)
-- so it is safe on installs that already have the rows: it will simply refresh
-- their metadata to the current canonical values.
--
-- migrate_0.7.4.sql is INTENTIONALLY NOT edited here — it is already applied on
-- production databases (the upgrade path uses recorded migration versions and
-- skips those it has already executed). Editing a migration that has already
-- run on prod has zero effect on existing installs while risking drift if it is
-- ever re-applied. The compat-preserving fix is a new migration pinned to the
-- next release version (0.7.6) so the updater picks it up on the 0.7.5 → 0.7.6
-- upgrade.
--
-- See CLAUDE.md "Migration file version MUST be ≤ release version" — version.json
-- has been bumped to 0.7.6 to ensure this file runs (the updater compares
-- migrationVersion <= toVersion).

-- ─── Re-register oai-pmh-server (canonical metadata, mirrors migrate_0.6.0.sql) ─

INSERT INTO plugins
    (name, display_name, description, version, author, author_url,
     plugin_url, is_active, path, main_file, requires_php, requires_app,
     metadata, installed_at)
VALUES
    ('oai-pmh-server',
     'OAI-PMH Server (libri + archivi)',
     'Server OAI-PMH 2.0 completo per esposizione del catalogo libri e archivi a harvester nazionali (Internet Culturale, Europeana, DPLA). Supporta oai_dc, MARCXML, MODS e MAG 2.0.1. Endpoint GET/POST /oai con deletedRecord=persistent.',
     '1.0.0', 'Fabiodalez', '',
     'https://www.openarchives.org/pmh/',
     0,
     'oai-pmh-server',
     'wrapper.php',
     '8.1',
     '0.6.0',
     '{"category":"protocol","tags":["oai-pmh","interoperability","iccu","europeana","marcxml","mods","mag","books"],"optional":true,"status":"stable"}',
     NOW())
ON DUPLICATE KEY UPDATE
    display_name  = VALUES(display_name),
    description   = VALUES(description),
    version       = VALUES(version),
    plugin_url    = VALUES(plugin_url),
    path          = VALUES(path),
    main_file     = VALUES(main_file),
    requires_php  = VALUES(requires_php),
    requires_app  = VALUES(requires_app),
    metadata      = VALUES(metadata);

-- ─── Re-register viaf-authority (canonical metadata, mirrors migrate_0.7.0.sql) ─

INSERT INTO plugins
    (name, display_name, description, version, author, author_url,
     plugin_url, is_active, path, main_file, requires_php, requires_app,
     metadata, installed_at)
VALUES
    ('viaf-authority',
     'VIAF Authority Control',
     'Collegamento degli autori al Virtual International Authority File (VIAF/OCLC) e ISNI (ISO 27729). Aggiunge campi VIAF/ISNI, alternates e API di riconciliazione W3C.',
     '1.1.0', 'Fabiodalez', '',
     'https://viaf.org/',
     0,
     'viaf-authority',
     'wrapper.php',
     '8.1',
     '0.7.0',
     '{"category":"authority","tags":["viaf","isni","authority-control","authors","interoperability","linked-data"],"optional":true,"status":"stable"}',
     NOW())
ON DUPLICATE KEY UPDATE
    display_name  = VALUES(display_name),
    description   = VALUES(description),
    version       = VALUES(version),
    plugin_url    = VALUES(plugin_url),
    path          = VALUES(path),
    main_file     = VALUES(main_file),
    requires_php  = VALUES(requires_php),
    requires_app  = VALUES(requires_app),
    metadata      = VALUES(metadata);
