-- Pinakes v0.7.4 — MAG digital_assets table + NCIP partner schema additions
-- digital_assets: per-book digitization metadata (url, md5_hash, filesize, dimensions, ppi)
-- ncip_partners: add isil and notes columns (standard ILS partner attributes)

CREATE TABLE IF NOT EXISTS digital_assets (
    id           INT UNSIGNED      NOT NULL AUTO_INCREMENT,
    libro_id     INT               NOT NULL,
    url          VARCHAR(500)      NOT NULL,
    md5_hash     CHAR(32)          NOT NULL DEFAULT '',
    filesize     BIGINT UNSIGNED   NOT NULL DEFAULT 0,
    image_width  INT UNSIGNED      NOT NULL DEFAULT 0,
    image_height INT UNSIGNED      NOT NULL DEFAULT 0,
    ppi          SMALLINT UNSIGNED NOT NULL DEFAULT 300,
    filetype     VARCHAR(32)       NOT NULL DEFAULT 'PDF',
    created_at   TIMESTAMP         NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   TIMESTAMP         NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    INDEX idx_libro_id (libro_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Add ISIL and notes to ncip_partners; relax legacy NOT NULL constraint on code
ALTER TABLE ncip_partners ADD COLUMN isil  VARCHAR(64) NULL AFTER endpoint_url;
ALTER TABLE ncip_partners ADD COLUMN notes TEXT        NULL AFTER isil;
ALTER TABLE ncip_partners MODIFY COLUMN code VARCHAR(64) NULL DEFAULT NULL;
