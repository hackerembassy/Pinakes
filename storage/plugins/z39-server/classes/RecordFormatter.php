<?php
/**
 * Record Formatter Factory
 *
 * Creates appropriate formatter for requested record format.
 * Supports: MARCXML, Dublin Core, MODS, OAI Dublin Core
 */

declare(strict_types=1);

namespace Z39Server;

abstract class RecordFormatter
{
    protected \DOMDocument $doc;

    public function __construct(\DOMDocument $doc)
    {
        $this->doc = $doc;
    }

    /**
     * Create formatter for specified format
     *
     * @param string $format Format name (marcxml, dc, mods, oai_dc)
     * @param \DOMDocument $doc DOM document
     * @return RecordFormatter Formatter instance
     * @throws \Exception If format is not supported
     */
    public static function create(string $format, \DOMDocument $doc): RecordFormatter
    {
        switch (strtolower($format)) {
            case 'marcxml':
                return new MARCXMLFormatter($doc);

            case 'dc':
            case 'oai_dc':
                return new DublinCoreFormatter($doc);

            case 'mods':
                return new MODSFormatter($doc);

            case 'unimarcxml':
                return new UNIMARCXMLFormatter($doc);

            default:
                throw new \Exception("Unsupported record format: {$format}");
        }
    }

    /**
     * Format record data as XML element
     *
     * @param array $record Record data from database
     * @return \DOMElement Formatted record element
     */
    abstract public function format(array $record): \DOMElement;

    /**
     * Escape XML text
     *
     * @param string $text Text to escape
     * @return string Escaped text
     */
    protected function escapeXml(string $text): string
    {
        return htmlspecialchars($text, ENT_XML1 | ENT_QUOTES, 'UTF-8');
    }

    /**
     * Normalize the role-aware contributor payload supplied by SRU/Z39.
     * Older callers that only provide the historic `autori` string retain a
     * compatible principal/co-author representation.
     *
     * @param array<string,mixed> $record
     * @return list<array{nome:string,ruolo:string}>
     */
    protected function contributorRows(array $record): array
    {
        $allowed = ['principale', 'co-autore', 'traduttore', 'illustratore', 'curatore', 'colorista'];
        $rows = [];
        if (isset($record['contributors']) && is_array($record['contributors'])) {
            foreach ($record['contributors'] as $row) {
                if (!is_array($row)) {
                    continue;
                }
                $name = trim((string) ($row['nome'] ?? $row['name'] ?? ''));
                $role = (string) ($row['ruolo'] ?? 'co-autore');
                if ($name !== '' && in_array($role, $allowed, true)) {
                    $rows[] = ['nome' => $name, 'ruolo' => $role];
                }
            }
            if ($rows !== []) {
                return $rows;
            }
        }

        $authors = array_values(array_filter(array_map(
            'trim',
            explode('; ', (string) ($record['autori'] ?? ''))
        )));
        foreach ($authors as $index => $name) {
            $rows[] = ['nome' => $name, 'ruolo' => $index === 0 ? 'principale' : 'co-autore'];
        }
        return $rows;
    }

    protected function isCreatorRole(string $role): bool
    {
        return $role === 'principale' || $role === 'co-autore';
    }

    protected function roleTerm(string $role): string
    {
        return match ($role) {
            'traduttore' => 'translator',
            'illustratore' => 'illustrator',
            'curatore' => 'editor',
            'colorista' => 'colorist',
            default => 'author',
        };
    }
}
