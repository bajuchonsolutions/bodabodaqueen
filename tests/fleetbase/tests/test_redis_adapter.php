<?php
require __DIR__ . '/../compat/redis-config.php';
function eq($a, $b, $msg) { if ($a !== $b) { throw new RuntimeException($msg); } }
function rejects($url, $msg) {
    try { bbqRedisConfig(['REDIS_URL'=>$url]); } catch (InvalidArgumentException $e) { return; }
    throw new RuntimeException('Expected rejection: '.$msg);
}
$cfg = bbqRedisConfig(['REDIS_URL'=>'redis://default:p%40ss%3Aword@redis.internal:6379/0']);
eq($cfg['default']['password'], 'p@ss:word', 'password decoding');
eq($cfg['default']['username'], 'default', 'username');
eq($cfg['sql']['database'], 1, 'sql index');
eq($cfg['cache']['database'], 2, 'cache index');
eq($cfg['geocode-cache']['database'], 3, 'geocode index');
eq($cfg['default']['scheme'], 'tcp', 'plain internal network');
$secure=bbqRedisConfig(['REDIS_URL'=>'rediss://default:test@redis.internal:6379/1']);
eq($secure['default']['scheme'], 'tls', 'TLS Redis mode');
rejects('tcp://redis.internal', 'unrecognized scheme');
rejects('redis://redis.internal', 'missing password');
rejects('redis://default:test@redis.internal/cache', 'non-numeric index');
rejects('redis://default:test@redis.internal/13', 'index overflow');
rejects('redis://default:test@redis.internal/0?foo=bar', 'unexpected query');
echo "Redis adapter pure-PHP tests passed (no network).\n";
