<?php
declare(strict_types=1);

/**
 * Extract CREATE TABLE targets after removing PHP comments. DDL string tokens
 * remain intact, while prose such as "no CREATE TABLE here" cannot create a
 * false table name.
 *
 * @return list<string>
 */
function plugin_schema_declared_tables(string $source): array
{
    $withoutComments = '';
    foreach (token_get_all($source) as $token) {
        if (is_array($token) && in_array($token[0], [T_COMMENT, T_DOC_COMMENT], true)) {
            continue;
        }
        $withoutComments .= is_array($token) ? $token[1] : $token;
    }

    preg_match_all(
        '/CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:`([^`]+)`|([A-Za-z_][A-Za-z0-9_$]*))\s*\(/i',
        $withoutComments,
        $matches,
        PREG_SET_ORDER
    );
    $tables = array_values(array_unique(array_map(
        static fn(array $match): string => $match[1] !== '' ? $match[1] : $match[2],
        $matches
    )));
    sort($tables);
    return $tables;
}

/**
 * Return the union of CREATE TABLE targets declared anywhere in a plugin.
 * A plugin may move DDL into a schema helper without weakening the guard.
 *
 * @return list<string>
 */
function plugin_schema_declared_tables_in_directory(string $directory): array
{
    if (!is_dir($directory)) {
        return [];
    }

    $tables = [];
    $iterator = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($directory, FilesystemIterator::SKIP_DOTS)
    );
    foreach ($iterator as $file) {
        if (!$file->isFile() || strtolower($file->getExtension()) !== 'php') {
            continue;
        }
        $source = @file_get_contents($file->getPathname());
        if ($source === false) {
            throw new RuntimeException('Cannot read plugin schema source: ' . $file->getPathname());
        }
        $tables = array_merge($tables, plugin_schema_declared_tables($source));
    }

    $tables = array_values(array_unique($tables));
    sort($tables);
    return $tables;
}
