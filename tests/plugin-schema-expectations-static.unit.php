<?php
declare(strict_types=1);

require_once __DIR__ . '/../vendor/autoload.php';
require_once __DIR__ . '/helpers/plugin-schema-source.php';

$testNo = 0;
$check = static function (bool $condition, string $description) use (&$testNo): void {
    $testNo++;
    if (!$condition) {
        fwrite(STDERR, sprintf("[%02d] FAIL: %s\n", $testNo, $description));
        exit(1);
    }
    printf("[%02d] PASS: %s\n", $testNo, $description);
};

$root = dirname(__DIR__);
$checked = 0;
$schemaOwners = 0;
foreach (\App\Support\BundledPlugins::LIST as $slug) {
    $pluginDir = $root . '/storage/plugins/' . $slug;
    $ddlTables = plugin_schema_declared_tables_in_directory($pluginDir);
    if ($ddlTables === []) {
        continue;
    }
    $schemaOwners++;

    $files = glob($pluginDir . '/*Plugin.php') ?: [];
    sort($files);
    $file = null;
    foreach ($files as $candidate) {
        $candidateSource = (string) file_get_contents($candidate);
        if (preg_match('/function\s+expectedTables\s*\(/', $candidateSource)) {
            $file = $candidate;
            break;
        }
    }
    $check($file !== null, "{$slug}: schema-owning plugin has an expectedTables() implementation");
    $source = (string) file_get_contents($file);

    require_once $file;
    preg_match('/^namespace\s+([^;]+);/m', $source, $namespaceMatch);
    $shortClass = basename($file, '.php');
    $className = isset($namespaceMatch[1]) ? $namespaceMatch[1] . '\\' . $shortClass : $shortClass;
    $check(class_exists($className, false), "{$slug}: main plugin class is loadable");
    $check(method_exists($className, 'expectedTables'), "{$slug}: schema-owning plugin declares expectedTables()");

    $instance = (new ReflectionClass($className))->newInstanceWithoutConstructor();
    $expected = array_values(array_unique(array_map('strval', $instance->expectedTables())));
    sort($expected);
    $check(
        $expected === $ddlTables,
        "{$slug}: expectedTables() exactly matches CREATE TABLE declarations"
    );
    $checked++;
}

$check($checked === $schemaOwners, "covered every bundled schema-owning plugin ({$checked})");
echo "ALL {$testNo} PASS\n";
