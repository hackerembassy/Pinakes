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

-- Aggiorna i trigger di integrità prestito sulle copie alla definizione corrente
-- (installer/database/triggers.sql): esclude anche 'in_restauro' e 'in_trasferimento'
-- dalle copie prestabili e usa 'da_ritirare' (non 'pendente', che ha attivo=0) nel
-- controllo di sovrapposizione. Per gli install ESISTENTI questi trigger erano alla
-- versione precedente: li ricreiamo (DROP + CREATE). Il runner delle migrazioni
-- gestisce i blocchi DELIMITER; il fallimento dei trigger (es. privilegio TRIGGER
-- mancante) è non fatale — le stesse regole sono applicate a livello applicativo.

DROP TRIGGER IF EXISTS `trg_check_active_prestito_before_insert`;
DELIMITER $$
CREATE TRIGGER `trg_check_active_prestito_before_insert`
BEFORE INSERT ON `prestiti`
FOR EACH ROW
BEGIN
    -- #157 model A-refined: a copy is "held" by an active loan OR by a
    -- reservation-conversion 'pendente' that already carries a copia_id.
    IF (NEW.copia_id IS NOT NULL AND (NEW.attivo = 1 OR NEW.stato = 'pendente')) THEN
        IF NOT EXISTS (
            SELECT 1
            FROM copie c
            WHERE c.id = NEW.copia_id
              AND c.stato NOT IN ('perso', 'danneggiato', 'manutenzione', 'in_restauro', 'in_trasferimento')
        ) THEN
            SIGNAL SQLSTATE '45000'
                SET MESSAGE_TEXT = 'La copia non è disponibile per il prestito.';
        END IF;

        IF EXISTS (
            SELECT 1
            FROM prestiti p
            WHERE p.copia_id = NEW.copia_id
              AND p.data_prestito <= NEW.data_scadenza
              AND p.data_scadenza >= NEW.data_prestito
              AND (
                  (p.attivo = 1 AND p.stato IN ('in_corso','in_ritardo','prenotato','da_ritirare'))
                  OR (p.stato = 'pendente' AND p.copia_id IS NOT NULL)
              )
        ) THEN
            SIGNAL SQLSTATE '45000'
                SET MESSAGE_TEXT = 'Esiste già un prestito attivo e sovrapposto per questa copia.';
        END IF;
    END IF;
END$$
DELIMITER ;

DROP TRIGGER IF EXISTS `trg_check_active_prestito_before_update`;
DELIMITER $$
CREATE TRIGGER `trg_check_active_prestito_before_update`
BEFORE UPDATE ON `prestiti`
FOR EACH ROW
BEGIN
    -- #157 model A-refined: a copy is "held" by an active loan OR by a
    -- reservation-conversion 'pendente' that already carries a copia_id.
    IF (NEW.copia_id IS NOT NULL AND (NEW.attivo = 1 OR NEW.stato = 'pendente')) THEN
        IF NOT EXISTS (
            SELECT 1
            FROM copie c
            WHERE c.id = NEW.copia_id
              AND c.stato NOT IN ('perso', 'danneggiato', 'manutenzione', 'in_restauro', 'in_trasferimento')
        ) THEN
            SIGNAL SQLSTATE '45000'
                SET MESSAGE_TEXT = 'La copia non è disponibile per il prestito.';
        END IF;

        IF EXISTS (
            SELECT 1
            FROM prestiti p
            WHERE p.copia_id = NEW.copia_id
              AND p.id <> NEW.id
              AND p.data_prestito <= NEW.data_scadenza
              AND p.data_scadenza >= NEW.data_prestito
              AND (
                  (p.attivo = 1 AND p.stato IN ('in_corso','in_ritardo','prenotato','da_ritirare'))
                  OR (p.stato = 'pendente' AND p.copia_id IS NOT NULL)
              )
        ) THEN
            SIGNAL SQLSTATE '45000'
                SET MESSAGE_TEXT = 'Esiste già un prestito attivo e sovrapposto per questa copia.';
        END IF;
    END IF;
END$$
DELIMITER ;
