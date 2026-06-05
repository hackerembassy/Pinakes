-- Migration 0.7.17 — loan-system configurable settings.
--
-- Adds three new admin-configurable parameters to system_settings
-- (category 'loans') that control default loan duration, maximum active
-- loans per user, and maximum number of renewals.
--
-- All three INSERT statements use INSERT IGNORE so the migration is
-- idempotent and safe to re-run on installations that already have
-- the rows (e.g. fresh installs seeded from data_*.sql).

INSERT IGNORE INTO `system_settings` (`category`, `setting_key`, `setting_value`, `description`) VALUES
('loans', 'loan_duration_days', '30', 'Durata predefinita di un prestito in giorni');

INSERT IGNORE INTO `system_settings` (`category`, `setting_key`, `setting_value`, `description`) VALUES
('loans', 'max_active_loans_per_user', '0', 'Numero massimo di prestiti attivi per utente (0 = nessun limite)');

INSERT IGNORE INTO `system_settings` (`category`, `setting_key`, `setting_value`, `description`) VALUES
('loans', 'max_renewals', '3', 'Numero massimo di rinnovi consentiti per prestito');

INSERT IGNORE INTO `system_settings` (`category`, `setting_key`, `setting_value`, `description`) VALUES
('loans', 'pickup_expiry_days', '3', 'Giorni per ritirare un prestito approvato prima che scada');

-- Trigger di integrità prestito (overlap copia, modello #157).
--
-- IMPORTANTE: un upgrade applica QUESTA migrazione con il codice della versione
-- DI PARTENZA (in memoria nello stesso request). Il runner delle migrazioni
-- delle versioni < 0.7.17 splitta lo SQL su ';' e NON gestisce i blocchi
-- DELIMITER / i corpi BEGIN…END dei trigger: ricrearli qui con DELIMITER
-- ROMPEREBBE l'aggiornamento con un errore di sintassi (regressione confermata
-- dal reinstall-test 0.7.16 → 0.7.17).
--
-- Quindi qui ci limitiamo a RIMUOVERE i trigger nella loro definizione
-- precedente (incompatibile col modello #157: vecchia occupazione basata solo
-- su attivo=1, senza 'da_ritirare' né pending-con-copia). DROP è uno statement
-- semplice, eseguibile da qualsiasi runner. La correttezza è garantita a
-- livello applicativo (lock FOR UPDATE + predicato di occupazione unificato in
-- tutti gli entry-point). I trigger nella definizione corrente vengono applicati
-- dalla fresh install via installer/database/triggers.sql e ri-applicati dal
-- passo post-migrazione dell'Updater (>= 0.7.17), che usa un parser
-- DELIMITER-aware.
DROP TRIGGER IF EXISTS `trg_check_active_prestito_before_insert`;
DROP TRIGGER IF EXISTS `trg_check_active_prestito_before_update`;
