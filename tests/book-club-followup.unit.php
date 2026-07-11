<?php
declare(strict_types=1);

/** Source-level regression guards for the PR #250 follow-up fixes. */

$failed = 0;
$passed = 0;
$check = static function (bool $condition, string $label) use (&$failed, &$passed): void {
    if ($condition) {
        $passed++;
        echo "  OK  {$label}\n";
        return;
    }
    $failed++;
    echo "  FAIL {$label}\n";
};

$root = dirname(__DIR__);
$view = file_get_contents($root . '/storage/plugins/book-club/views/public/show.php');
$controller = file_get_contents($root . '/storage/plugins/book-club/src/PublicController.php');
$repo = file_get_contents($root . '/storage/plugins/book-club/src/Repo.php');

$check($view !== false && str_contains($view, 'data-swal-confirm='), 'book removal uses the shared SweetAlert2 guard');
$swalPosition = $view !== false ? strpos($view, 'data-swal-confirm=') : false;
$removeMarkup = $swalPosition !== false ? substr((string) $view, max(0, $swalPosition - 250), 750) : '';
$check(!str_contains($removeMarkup, 'onsubmit="return confirm('), 'book removal has no unsafe inline native confirm');
$check($controller !== false && str_contains($controller, "'key' => BookClubPlugin::STATE_PENDING"), 'manager PDF renders pending proposals as a state');
$check($controller !== false && str_contains($controller, 'userLabel($proposerId)'), 'proposal notification resolves the attributed member label');
$check($repo !== false && str_contains($repo, 'SELECT external_book_id FROM bookclub_books WHERE id = ? FOR UPDATE'), 'book removal locks the target row');
$check($repo !== false && str_contains($repo, 'club-book removal rolled back'), 'book removal rolls back and logs atomic failures');

echo "\nPassed: {$passed}   Failed: {$failed}\n";
exit($failed > 0 ? 1 : 0);
