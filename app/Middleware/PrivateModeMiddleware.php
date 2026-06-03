<?php
declare(strict_types=1);

namespace App\Middleware;

use App\Support\ConfigStore;
use App\Support\HtmlHelper;
use App\Support\RouteTranslator;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface as RequestHandler;
use Slim\Psr7\Response as SlimResponse;

/**
 * Private mode (issue #158): when an administrator enables
 * security.private_mode, the entire public site is restricted to authenticated
 * users. Logged-out visitors are redirected to the login page and only the
 * authentication flow, the installer and static assets stay reachable.
 *
 * Off by default — the library remains fully public unless an admin opts in.
 *
 * Runs AFTER RememberMeMiddleware so a returning user auto-logged-in via a
 * persistent token is already recognised here.
 */
class PrivateModeMiddleware implements MiddlewareInterface
{
    /** Auth route keys that must stay reachable while logged out. */
    private const AUTH_ROUTE_KEYS = [
        'login', 'logout', 'register', 'register_success',
        'verify_email', 'forgot_password', 'reset_password',
    ];

    /** Locales whose route variants are all registered in web.php. */
    private const LOCALES = ['it_IT', 'en_US', 'de_DE', 'fr_FR'];

    /** Path prefixes always allowed (assets, installer, infra endpoints). */
    private const ALLOWED_PREFIXES = [
        '/assets/', '/uploads/', '/css/', '/js/', '/img/', '/images/', '/fonts/',
        '/installer', '/language/', '/health', '/favicon', '/robots.txt',
        '/sitemap', '/feed.xml', '/llms.txt', '/.well-known/',
    ];

    public function process(Request $request, RequestHandler $handler): Response
    {
        // Authenticated users are never restricted by this middleware.
        if (!empty($_SESSION['user'])) {
            return $handler->handle($request);
        }

        // Feature is opt-in and off by default.
        if ((string) ConfigStore::get('advanced.private_mode', '0') !== '1') {
            return $handler->handle($request);
        }

        $path = $this->normalizePath($request->getUri()->getPath());

        if ($this->isAllowed($path)) {
            return $handler->handle($request);
        }

        // API consumers get a JSON 401; browsers are redirected to the login page.
        if (str_starts_with($path, '/api/')) {
            $res = new SlimResponse(401);
            $res->getBody()->write(json_encode([
                'error' => true,
                'message' => __('Autenticazione richiesta.'),
            ], JSON_UNESCAPED_UNICODE));
            return $res->withHeader('Content-Type', 'application/json');
        }

        $loginUrl = RouteTranslator::route('login') . '?error=private_mode';
        return (new SlimResponse(302))->withHeader('Location', $loginUrl);
    }

    /** Strip the base path (subfolder installs) so comparisons are absolute. */
    private function normalizePath(string $path): string
    {
        $basePath = HtmlHelper::getBasePath();
        if ($basePath !== '' && $basePath !== '/' && str_starts_with($path, $basePath)) {
            $path = substr($path, strlen($basePath));
        }
        return $path === '' ? '/' : $path;
    }

    private function isAllowed(string $path): bool
    {
        // Locale-aware auth routes (all registered variants, any install locale).
        foreach (self::AUTH_ROUTE_KEYS as $key) {
            foreach (self::LOCALES as $locale) {
                $route = RouteTranslator::getRouteForLocale($key, $locale);
                if ($route !== '' && ($path === $route || str_starts_with($path, $route . '/'))) {
                    return true;
                }
            }
        }

        // Legacy English login aliases always registered in web.php.
        if ($path === '/login' || $path === '/login.php') {
            return true;
        }

        // Static assets, installer and infrastructure endpoints.
        foreach (self::ALLOWED_PREFIXES as $prefix) {
            if (str_starts_with($path, $prefix)) {
                return true;
            }
        }

        return false;
    }
}
