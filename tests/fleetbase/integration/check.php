<?php
declare(strict_types=1);
require __DIR__ . '/../compat/redis-config.php';
function requireEnv(string $name): string {
    $value = getenv($name);
    if (!is_string($value) || $value === '') { throw new RuntimeException("Missing test variable: $name"); }
    return $value;
}
function expect(bool $pass, string $message): void { if (!$pass) { throw new RuntimeException($message); } }
function sql(string $user, string $password): PDO {
    return new PDO('mysql:host=mysql;port=3306;charset=utf8mb4', $user, $password,
        [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_TIMEOUT => 5]);
}
$rootPassword = requireEnv('LOCAL_MYSQL_ROOT_PASSWORD');
$runtimePassword = requireEnv('LOCAL_MYSQL_RUNTIME_PASSWORD');
$migratorPassword = requireEnv('LOCAL_MYSQL_MIGRATOR_PASSWORD');
$redisPassword = requireEnv('LOCAL_REDIS_PASSWORD');
$root = sql('root', $rootPassword);
$root->exec('CREATE DATABASE IF NOT EXISTS fleetbase_staging CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
foreach (['fleetbase_migrator' => $migratorPassword, 'fleetbase_runtime' => $runtimePassword] as $name => $password) {
    $root->exec("CREATE USER IF NOT EXISTS '$name'@'%' IDENTIFIED BY " . $root->quote($password));
}
$root->exec("GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, DROP, REFERENCES, CREATE TEMPORARY TABLES ON fleetbase_staging.* TO 'fleetbase_migrator'@'%'");
$root->exec("GRANT SELECT, INSERT, UPDATE, DELETE ON fleetbase_staging.* TO 'fleetbase_runtime'@'%'");
$migrator = sql('fleetbase_migrator', $migratorPassword);
$migrator->exec('CREATE TABLE fleetbase_staging.integration_gate (id INT PRIMARY KEY, note VARCHAR(32))');
$runtime = sql('fleetbase_runtime', $runtimePassword);
$runtime->exec("INSERT INTO fleetbase_staging.integration_gate VALUES (1, 'test')");
expect($runtime->query('SELECT COUNT(*) FROM fleetbase_staging.integration_gate')->fetchColumn() === 1 ||
       (int)$runtime->query('SELECT COUNT(*) FROM fleetbase_staging.integration_gate')->fetchColumn() === 1,
       'runtime user cannot query');
$denied = false;
try { $runtime->exec('ALTER TABLE fleetbase_staging.integration_gate ADD COLUMN prohibited INT'); }
catch (PDOException $e) { $denied = true; }
expect($denied, 'Runtime user unexpectedly has ALTER privilege');
echo "PASS MySQL: migrator DDL, runtime DML, runtime ALTER denied\n";
$url = 'redis://default:' . rawurlencode($redisPassword) . '@redis:6379/0';
$config = bbqRedisConfig(['REDIS_URL' => $url]);
foreach ($config as $label => $settings) {
    $client = new Redis();
    expect($client->connect($settings['host'], $settings['port'], 3.0), "Redis connect failed ($label)");
    expect($client->auth([$settings['username'], $settings['password']]), "Redis auth failed ($label)");
    expect($client->select($settings['database']), "Redis select failed ($label)");
    $key='bbq-test-'.$label;
    expect($client->setex($key, 20, 'ready') !== false, "Redis write failed ($label)");
    expect($client->get($key) === 'ready', "Redis read failed ($label)");
    $client->del($key);
    $client->close();
}
$unauthorized = new Redis();
$unauthorized->connect('redis', 6379, 3.0);
$rejected = false;
try { $rejected = !$unauthorized->auth(['default', 'deliberately-wrong-password']); }
catch (RedisException $e) { $rejected = true; }
expect($rejected, 'Redis allowed an invalid password');
echo "PASS Redis: authenticated read/write across four numeric DBs; wrong password denied\n";
$queue = new Redis();
$queue->connect('redis', 6379, 3.0);
expect($queue->auth(['default', $redisPassword]), 'Queue Redis auth failed');
$queue->select(0);
$queue->lPush('bbq-test-queue', 'job-one');
expect($queue->rPop('bbq-test-queue') === 'job-one', 'Redis list queue round-trip failed');
echo "PASS Redis: synthetic list queue round-trip (NOT Laravel queue worker validation)\n";
