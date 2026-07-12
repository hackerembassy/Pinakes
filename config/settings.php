<?php
declare(strict_types=1);

// Read both phpdotenv-populated $_ENV and real process variables. With
// createImmutable(), an already exported variable is intentionally not copied
// into $_ENV; reading only $_ENV made CLI cron/container runs connect as user ''.
$envValue = static function (string $key, mixed $default = null): mixed {
    if (array_key_exists($key, $_ENV)) {
        $v = $_ENV[$key];
        // Treat an explicitly empty string as "unset" so e.g. DB_PORT="" falls
        // back to the default (3306) instead of casting to 0 → mysqli connect fail.
        return ($v === '') ? $default : $v;
    }
    $value = getenv($key);
    return ($value === false || $value === '') ? $default : $value;
};

// Basic settings; expand as needed
$appDebug = $envValue('APP_DEBUG');
$appEnv = $envValue('APP_ENV');
$displayErrorsEnv = $envValue('DISPLAY_ERRORS');
$settings = [
    'displayErrorDetails' => $appDebug !== null ? filter_var($appDebug, FILTER_VALIDATE_BOOL) : false,
    'canonicalUrl' => $envValue('APP_CANONICAL_URL'),
    'db' => [
        'hostname' => $envValue('DB_HOST', 'localhost'),
        'username' => $envValue('DB_USER'),
        'password' => $envValue('DB_PASS'),
        'database' => $envValue('DB_NAME'),
        'port'     => (int) $envValue('DB_PORT', 3306),
        'charset'  => 'utf8mb4',
        'socket'   => $envValue('DB_SOCKET'), // Optional socket path
    ],
];

// Configure PHP error display based on DISPLAY_ERRORS env variable
if ($displayErrorsEnv !== null) {
    $displayErrors = filter_var($displayErrorsEnv, FILTER_VALIDATE_BOOL);
    ini_set('display_errors', $displayErrors ? '1' : '0');
    ini_set('display_startup_errors', $displayErrors ? '1' : '0');
} elseif ($appEnv === 'production') {
    // Force disable error display in production
    ini_set('display_errors', '0');
    ini_set('display_startup_errors', '0');
}

// Local override file (optional): config.local.php
// Supports: $db_config array and other PHP ini tweaks.
$local = __DIR__ . '/../config.local.php';
if (is_file($local)) {
    /** @var array|null $db_config */
    $db_config = null;
    include $local;
    if (is_array($db_config)) {
        $settings['db'] = array_merge($settings['db'], $db_config);
    }
}

return $settings;
