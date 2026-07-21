<?php
declare(strict_types=1);

/**
 * Guards for two changes (issues #262/#265 and #237):
 *
 *  A. The shared auth custom-CSS partial MUST sanitize with
 *     ContentSanitizer::sanitizeCustomCss() — the render-time sanitizer that
 *     strips <style>/<script> breakout — NOT normalizeExternalAssets() (fonts
 *     only). PR #265 shipped the unsafe sanitizer, which would reintroduce the
 *     stored-XSS breakout on unauthenticated auth pages. This locks the fix in.
 *
 *  B. The contributor pickers' role-specific help strings (#237) must exist in
 *     ALL four locale files, so no locale falls back to the generic text.
 *
 * Run:  php tests/auth-custom-css-and-contributor-help.unit.php  (exit 0 iff pass)
 */

$root = dirname(__DIR__);
$pass = 0;
$fail = 0;
$check = static function (bool $ok, string $label) use (&$pass, &$fail): void {
    if ($ok) { $pass++; echo "  OK  {$label}\n"; }
    else     { $fail++; echo "  FAIL {$label}\n"; }
};

echo "A. Auth custom-CSS partial uses the safe render-time sanitizer\n";
$partial = (string) file_get_contents($root . '/app/Views/auth/partials/custom-css.php');
$check(str_contains($partial, 'ContentSanitizer::sanitizeCustomCss('),
    'partial calls ContentSanitizer::sanitizeCustomCss()');
// The value that reaches <style> must NOT be produced solely by the fonts-only
// normalizer. sanitizeCustomCss() calls normalizeExternalAssets() internally,
// so we assert the *assignment* of $customCss does not use the bare normalizer.
$check(!preg_match('/\$customCss\s*=\s*[^;]*normalizeExternalAssets\s*\(/', $partial),
    'partial does NOT assign $customCss from bare normalizeExternalAssets() (racy PR #265 form)');

echo "B. Every auth view + the frontend layout include the shared partial\n";
$authViews = ['login', 'register', 'register_success', 'forgot-password', 'reset-password'];
foreach ($authViews as $v) {
    $src = (string) file_get_contents($root . "/app/Views/auth/{$v}.php");
    $check(str_contains($src, "partials/custom-css.php"),
        "auth/{$v}.php includes the custom-css partial");
}
$layout = (string) file_get_contents($root . '/app/Views/frontend/layout.php');
$check(str_contains($layout, 'auth/partials/custom-css.php'),
    'frontend/layout.php includes the shared partial (no duplicate inline block)');
$check(substr_count($layout, "ConfigStore::get('advanced.custom_header_css'") === 0,
    'frontend/layout.php no longer has its own inline custom_header_css block');

echo "C. Role-specific contributor help strings exist in all four locales (#237)\n";
$roleHelp = [
    'Cerca un illustratore esistente o aggiungine uno nuovo digitando il nome',
    'Cerca un traduttore esistente o aggiungine uno nuovo digitando il nome',
    'Cerca un curatore esistente o aggiungine uno nuovo digitando il nome',
    'Cerca un colorista esistente o aggiungine uno nuovo digitando il nome (utile per i fumetti)',
];
$form = (string) file_get_contents($root . '/app/Views/libri/partials/book_form.php');
foreach ($roleHelp as $s) {
    $check(str_contains($form, $s), "book_form.php uses role help: \"" . mb_substr($s, 0, 32) . "…\"");
}
foreach (['it_IT', 'en_US', 'de_DE', 'fr_FR'] as $loc) {
    $json = json_decode((string) file_get_contents($root . "/locale/{$loc}.json"), true);
    $missing = array_filter($roleHelp, static fn ($k) => !isset($json[$k]) || $json[$k] === '');
    $check($missing === [], "{$loc}.json has all 4 role-help keys translated");
}

echo "\n" . ($fail === 0 ? "ALL {$pass} PASS\n" : "{$pass} PASS, {$fail} FAIL\n");
exit($fail === 0 ? 0 : 1);
