# Test runner only; not a Fleetbase app image.
FROM php:8.3-cli-bookworm
RUN docker-php-ext-install pdo_mysql && pecl install redis-6.2.0 && docker-php-ext-enable redis
WORKDIR /checks
COPY compat /checks/compat
COPY integration/check.php /checks/integration/check.php
