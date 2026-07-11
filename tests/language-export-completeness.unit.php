<?php
declare(strict_types=1);

/**
 * Language export completeness — Nikola #238.
 *
 * A partly-translated custom language (e.g. nb_NO) used to export only its own
 * keys, so "Download JSON" produced an incomplete file and the stats read
 * 100% against the old key count — you couldn't tell which NEW keys were still
 * missing. The fix makes download() emit EVERY current application key (from the
 * canonical it_IT set), with an empty string for anything not yet translated,
 * and keeps any extra custom keys at the end.
 *
 * This drives the REAL LanguagesController::download() against a seeded partial
 * nb_NO catalogue and inspects the produced JSON — not a str_contains check.
 */

require __DIR__ . '/../vendor/autoload.php';
require __DIR__ . '/../app/helpers.php';

if (session_status() !== PHP_SESSION_ACTIVE) {
    @session_start();
}

$TESTNO = 0;
$failed = 0;
function check(bool $cond, string $desc): void
{
    global $TESTNO, $failed;
    $TESTNO++;
    printf("[%02d] %s: %s\n", $TESTNO, $cond ? 'PASS' : 'FAIL', $desc);
    if (!$cond) {
        $failed++;
    }
}

/* ------------------------------ DB connect ------------------------------ */
function le_env(string $path): array
{
    $env = [];
    foreach (@file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [] as $line) {
        if ($line === '' || $line[0] === '#' || !str_contains($line, '=')) {
            continue;
        }
        [$k, $v] = explode('=', $line, 2);
        $k = trim($k);
        $v = trim($v);
        if (strlen($v) >= 2 && ($v[0] === '"' || $v[0] === "'") && $v[-1] === $v[0]) {
            $v = substr($v, 1, -1);
        }
        $env[$k] = $v;
    }
    return $env;
}
$env    = le_env(__DIR__ . '/../.env');
$socket = getenv('E2E_DB_SOCKET') ?: ($env['DB_SOCKET'] ?? '/opt/homebrew/var/mysql/mysql.sock');
$user   = getenv('E2E_DB_USER') ?: ($env['DB_USER'] ?? '');
$pass   = getenv('E2E_DB_PASS') ?: ($env['DB_PASS'] ?? ($env['DB_PASSWORD'] ?? ''));
$name   = getenv('E2E_DB_NAME') ?: ($env['DB_NAME'] ?? '');
mysqli_report(MYSQLI_REPORT_OFF);
try {
    $db = (is_string($socket) && $socket !== '' && file_exists($socket))
        ? new mysqli(null, $user, $pass, $name, 0, $socket)
        : new mysqli($env['DB_HOST'] ?? '127.0.0.1', $user, $pass, $name, (int) ($env['DB_PORT'] ?? 3306));
} catch (\Throwable $e) {
    echo "SKIP: database not reachable (" . $e->getMessage() . ")\n";
    exit(0);
}
$db->set_charset('utf8mb4');

/* ---------------- seed a partial custom locale (nb_NO) ---------------- */
$code = 'nb_NO';
$localeFile = __DIR__ . '/../locale/' . $code . '.json';
$canonical = json_decode((string) file_get_contents(__DIR__ . '/../locale/it_IT.json'), true);
$canonicalKeys = array_keys($canonical);

// Translate the first two canonical keys; leave the rest missing. Add one
// extra custom key that is NOT in the canonical set.
$translatedKey1 = $canonicalKeys[0];
$translatedKey2 = $canonicalKeys[1];
$missingKey     = $canonicalKeys[2];               // present in canonical, absent here
$partial = [
    $translatedKey1 => 'NB oversettelse 1',
    $translatedKey2 => 'NB oversettelse 2',
    'zzz_custom_extra_key' => 'egendefinert',
];
$hadFile = file_exists($localeFile);
$backup = $hadFile ? (string) file_get_contents($localeFile) : null;
file_put_contents($localeFile, json_encode($partial, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));

$db->query("DELETE FROM languages WHERE code='{$code}'");
$db->query("INSERT INTO languages (code, name, native_name, is_active, translation_file, created_at)
            VALUES ('{$code}', 'Norwegian', 'Norsk', 1, '{$code}.json', NOW())");

$cleanup = static function () use ($db, $code, $localeFile, $hadFile, $backup): void {
    $db->query("DELETE FROM languages WHERE code='{$code}'");
    if ($hadFile && $backup !== null) {
        file_put_contents($localeFile, $backup);
    } elseif (file_exists($localeFile)) {
        @unlink($localeFile);
    }
};

/* ---------------------- call the REAL download() ---------------------- */
try {
    $controller = new \App\Controllers\Admin\LanguagesController();
    $request = (new \Slim\Psr7\Factory\ServerRequestFactory())->createServerRequest('GET', '/admin/languages/' . $code . '/download');
    $response = new \Slim\Psr7\Response();
    $out = $controller->download($request, $response, $db, ['code' => $code]);

    $out->getBody()->rewind();
    $body = $out->getBody()->getContents();
    $exported = json_decode($body, true);

    check(is_array($exported), 'download() returns a JSON object');
    if (is_array($exported)) {
        // Every canonical key is present in the export…
        $missingFromExport = array_diff($canonicalKeys, array_keys($exported));
        check($missingFromExport === [], 'export contains EVERY current application key (' . count($canonicalKeys) . ' canonical keys)');
        // …translated keys keep their value…
        check(($exported[$translatedKey1] ?? null) === 'NB oversettelse 1', 'a translated key keeps its value');
        // …a not-yet-translated canonical key comes back as an EMPTY string…
        check(array_key_exists($missingKey, $exported) && $exported[$missingKey] === '', 'an untranslated key is exported as an empty string (identifiable gap)');
        // …and an extra custom key survives at the end.
        check(($exported['zzz_custom_extra_key'] ?? null) === 'egendefinert', 'extra custom keys are preserved');
    }
    check($out->getHeaderLine('Content-Type') !== '' && str_contains(strtolower($out->getHeaderLine('Content-Disposition') . $out->getHeaderLine('Content-Type')), 'json'), 'response is delivered as a JSON download');
} catch (\Throwable $e) {
    $cleanup();
    fwrite(STDERR, 'FAIL: ' . $e->getMessage() . "\n");
    exit(1);
}

$cleanup();
echo "\n" . ($failed === 0 ? "ALL {$TESTNO} PASS\n" : "{$failed}/{$TESTNO} FAILED\n");
exit($failed > 0 ? 1 : 0);
