<?php
/**
 * Proposed Fleetbase Redis configuration adapter (REVIEW-ONLY).
 * Include this from a reviewed, version-matched Fleetbase config/database.php.
 * Does not connect to Redis or modify any remote resource.
 */
function bbqRedisConfig(array $env): array {
    $url = $env['REDIS_URL'] ?? '';
    if (!is_string($url) || $url === '') {
        throw new InvalidArgumentException('REDIS_URL is required');
    }
    $parts = parse_url($url);
    if ($parts === false || !isset($parts['scheme'], $parts['host'])) {
        throw new InvalidArgumentException('Malformed REDIS_URL');
    }
    if (!in_array($parts['scheme'], ['redis', 'rediss'], true)) {
        throw new InvalidArgumentException('Redis scheme must be redis or rediss');
    }
    if (isset($parts['path']) && $parts['path'] !== '' && !preg_match('~^/[0-9]+$~D', $parts['path'])) {
        throw new InvalidArgumentException('Redis database index must be numeric');
    }
    if (isset($parts['query']) || isset($parts['fragment'])) {
        throw new InvalidArgumentException('Unexpected Redis URL query or fragment');
    }
    $password = isset($parts['pass']) ? rawurldecode($parts['pass']) : ($env['REDIS_PASSWORD'] ?? null);
    if (!is_string($password) || $password === '') {
        throw new InvalidArgumentException('Authenticated Redis password required');
    }
    $db = isset($parts['path']) && $parts['path'] !== '' ? (int) substr($parts['path'], 1) : 0;
    if ($db > 12) {
        throw new InvalidArgumentException('Redis database index too high for four assigned logical databases');
    }
    $port = $parts['port'] ?? 6379;
    $tls = $parts['scheme'] === 'rediss';
    $user = isset($parts['user']) ? rawurldecode($parts['user']) : 'default';
    $make = static function(int $index) use ($parts, $port, $password, $user, $tls): array {
        return [
            'host' => $parts['host'], 'port' => $port, 'username' => $user,
            'password' => $password, 'database' => $index,
            'scheme' => $tls ? 'tls' : 'tcp',
        ];
    };
    return [
        'default' => $make($db), 'sql' => $make($db+1),
        'cache' => $make($db+2), 'geocode-cache' => $make($db+3),
    ];
}
