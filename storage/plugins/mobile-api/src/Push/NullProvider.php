<?php

declare(strict_types=1);

namespace App\Plugins\MobileApi\Push;

/**
 * Fallback provider selected when no push credentials are configured
 * (spec §Push config: "if absent → graceful fallback to polling / in-app
 * notifications. Never hard-fail").
 *
 * It delivers nothing and reports SKIPPED for every subscription. A SKIPPED
 * result is NOT counted as a delivery failure (it never bumps failure_count), so
 * an unconfigured instance does not disable a user's devices. The same events
 * remain visible via GET /me/notifications (which the controller derives
 * independently from core state), so the user experience degrades to polling
 * rather than breaking.
 */
final class NullProvider implements PushProvider
{
    public function name(): string
    {
        return 'null';
    }

    public function send(array $subscription, PushPayload $payload): PushResult
    {
        // No-op by design: no transport, no credentials, no failure.
        return PushResult::skipped();
    }
}
