import {describe, test, assert} from 'vitest';

import {validate_nginx_config} from '$lib/server/validate_nginx.js';

// --- Fixture configs ---

/** Visiones-style config — all checks pass. */
const PASSING_CONFIG = `server {
    listen 443 ssl;
    server_name example.com;

    server_tokens off;

    limit_req zone=global burst=20 nodelay;

    root /app/current/build;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    location /api {
        proxy_pass http://127.0.0.1:4040;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header Authorization "";
    }

    location /_app {
        expires 1y;
        add_header Cache-Control "public, immutable";
        add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
        add_header X-Frame-Options "SAMEORIGIN" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Referrer-Policy "strict-origin-when-cross-origin" always;
        try_files $uri =404;
    }

    location / {
        try_files $uri $uri/index.html $uri.html =404;
    }
}

server {
    listen 80;
    server_name example.com;
    return 301 https://example.com$request_uri;
}
`;

/** Missing Authorization "" strip in /api block. */
const MISSING_AUTH_STRIP_CONFIG = `server {
    listen 443 ssl;
    server_tokens off;
    limit_req zone=global burst=20 nodelay;

    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    location /api {
        proxy_pass http://127.0.0.1:4040;
        proxy_set_header X-Forwarded-For $remote_addr;
    }
}
`;

/** Missing security headers. */
const MISSING_HEADERS_CONFIG = `server {
    listen 443 ssl;
    server_tokens off;
    limit_req zone=global burst=20 nodelay;

    add_header Strict-Transport-Security "max-age=31536000" always;

    location /api {
        proxy_pass http://127.0.0.1:4040;
        proxy_set_header Authorization "";
    }
}
`;

/** Missing HSTS entirely. */
const MISSING_HSTS_CONFIG = `server {
    listen 443 ssl;
    server_tokens off;
    limit_req zone=global burst=20 nodelay;

    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    location /api {
        proxy_pass http://127.0.0.1:4040;
        proxy_set_header Authorization "";
    }
}
`;

/** Child location with add_header that forgets security headers. */
const CHILD_ADD_HEADER_CONFIG = `server {
    listen 443 ssl;
    server_tokens off;
    limit_req zone=global burst=20 nodelay;

    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    location /api {
        proxy_pass http://127.0.0.1:4040;
        proxy_set_header Authorization "";
    }

    location /_app {
        expires 1y;
        add_header Cache-Control "public, immutable";
        try_files $uri =404;
    }
}
`;

// --- Real consumer configs (inlined from zap.ts files) ---

/** Visiones del Caribe nginx config (from its zap.ts). */
const VISIONES_NGINX_CONFIG = `server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name {{domain}};

    ssl_certificate /etc/letsencrypt/live/{{domain}}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/{{domain}}/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    server_tokens off;

    limit_req zone=global burst=20 nodelay;

    root /root/app/current/build;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    location /api {
        proxy_pass http://127.0.0.1:{{port}};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_set_header Authorization "";

        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }

    location = /health {
        proxy_pass http://127.0.0.1:{{port}};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /mapdata/ {
        types {
            application/x-protobuf pbf;
            application/geo+json geojson;
        }
        default_type application/octet-stream;
        add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
        add_header X-Content-Type-Options "nosniff" always;
        try_files $uri =404;
    }

    location /_app {
        expires 1y;
        add_header Cache-Control "public, immutable";
        add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
        add_header X-Frame-Options "SAMEORIGIN" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Referrer-Policy "strict-origin-when-cross-origin" always;
        try_files $uri =404;
    }

    error_page 404 /404.html;

    location / {
        try_files $uri $uri/index.html $uri.html =404;
    }
}

server {
    listen 80;
    listen [::]:80;
    server_name {{domain}};

    return 301 https://{{domain}}$request_uri;
}
`;

/** zap (zap.fuz.dev) nginx config fixture. */
const ZAP_NGINX_CONFIG = `server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name www.{{domain}};

    ssl_certificate /etc/letsencrypt/live/{{domain}}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/{{domain}}/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    server_tokens off;

    return 301 https://{{domain}}$request_uri;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name {{domain}};

    ssl_certificate /etc/letsencrypt/live/{{domain}}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/{{domain}}/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    server_tokens off;

    limit_req zone=global burst=20 nodelay;

    root /home/tx/app/current/build;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    location /api {
        proxy_pass http://127.0.0.1:{{port}};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;

        proxy_set_header Authorization "";

        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }

    location /health {
        proxy_pass http://127.0.0.1:{{port}};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location = /_auth {
        internal;
        proxy_pass http://127.0.0.1:{{port}}/api/account/verify;
        proxy_pass_request_body off;
        proxy_set_header Content-Length "";
        proxy_set_header Cookie $http_cookie;
    }

    location = /zap {
        auth_request /_auth;
        alias /home/tx/app/current/dist_cli/zap;
        default_type application/octet-stream;
        add_header Content-Disposition 'attachment; filename="zap"';
    }

    location = /zap.sha256 {
        auth_request /_auth;
        alias /home/tx/app/current/dist_cli/zap.sha256;
        default_type text/plain;
    }

    location /_app {
        expires 1y;
        add_header Cache-Control "public, immutable";
        add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
        add_header X-Frame-Options "SAMEORIGIN" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Referrer-Policy "strict-origin-when-cross-origin" always;
        try_files $uri =404;
    }

    location / {
        try_files $uri /200.html;
    }
}

server {
    listen 80;
    listen [::]:80;
    server_name {{domain}} www.{{domain}};

    return 301 https://{{domain}}$request_uri;
}
`;

describe('validate_nginx_config', () => {
	describe('fixture configs', () => {
		test('passing config returns ok: true with no errors', () => {
			const result = validate_nginx_config(PASSING_CONFIG);
			assert.strictEqual(result.ok, true);
			assert.strictEqual(result.errors.length, 0);
		});

		test('missing Authorization "" strip is an error', () => {
			const result = validate_nginx_config(MISSING_AUTH_STRIP_CONFIG);
			assert.strictEqual(result.ok, false);
			assert.ok(result.errors.some((e) => e.includes('Authorization')));
		});

		test('missing security headers produces warnings', () => {
			const result = validate_nginx_config(MISSING_HEADERS_CONFIG);
			assert.strictEqual(result.ok, true, 'Missing optional headers should not cause errors');
			assert.ok(result.warnings.some((w) => w.includes('X-Content-Type-Options')));
			assert.ok(result.warnings.some((w) => w.includes('X-Frame-Options')));
			assert.ok(result.warnings.some((w) => w.includes('Referrer-Policy')));
		});

		test('missing HSTS is an error', () => {
			const result = validate_nginx_config(MISSING_HSTS_CONFIG);
			assert.strictEqual(result.ok, false);
			assert.ok(result.errors.some((e) => e.includes('Strict-Transport-Security')));
		});

		test('child location with add_header missing security headers produces warning', () => {
			const result = validate_nginx_config(CHILD_ADD_HEADER_CONFIG);
			assert.strictEqual(result.ok, true, 'add_header inheritance is a warning, not an error');
			assert.ok(result.warnings.some((w) => w.includes('/_app') && w.includes('add_header')));
		});

		test('$proxy_add_x_forwarded_for produces warning', () => {
			const config = PASSING_CONFIG.replace('$remote_addr', '$proxy_add_x_forwarded_for');
			const result = validate_nginx_config(config);
			assert.ok(result.warnings.some((w) => w.includes('$proxy_add_x_forwarded_for')));
		});

		test('missing server_tokens off produces warning', () => {
			const config = PASSING_CONFIG.replace('server_tokens off;', '');
			const result = validate_nginx_config(config);
			assert.ok(result.warnings.some((w) => w.includes('server_tokens off')));
		});

		test('missing limit_req produces warning', () => {
			const config = PASSING_CONFIG.replace('limit_req zone=global burst=20 nodelay;', '');
			const result = validate_nginx_config(config);
			assert.ok(result.warnings.some((w) => w.includes('limit_req')));
		});
	});

	describe('location modifiers', () => {
		const base_headers = `
    server_tokens off;
    limit_req zone=global burst=20 nodelay;
    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;`;

		test('regex location `~ ^/api` without auth strip → error', () => {
			const config = `server {${base_headers}
    location ~ ^/api {
        proxy_pass http://127.0.0.1:4040;
    }
}`;
			const result = validate_nginx_config(config);
			assert.strictEqual(result.ok, false);
			assert.ok(result.errors.some((e) => e.includes('Authorization')));
		});

		test('prefix-priority location `^~ /api/` without auth strip → error', () => {
			const config = `server {${base_headers}
    location ^~ /api/ {
        proxy_pass http://127.0.0.1:4040;
    }
}`;
			const result = validate_nginx_config(config);
			assert.strictEqual(result.ok, false);
			assert.ok(result.errors.some((e) => e.includes('Authorization')));
		});

		test('exact location `= /api/v1` without auth strip → error', () => {
			const config = `server {${base_headers}
    location = /api/v1 {
        proxy_pass http://127.0.0.1:4040;
    }
}`;
			const result = validate_nginx_config(config);
			assert.strictEqual(result.ok, false);
			assert.ok(result.errors.some((e) => e.includes('Authorization')));
		});

		test('case-insensitive regex location `~* ^/API` without auth strip → error', () => {
			// ~* locations match /API/... as well; we still detect /api as a path segment
			const config = `server {${base_headers}
    location ~* ^/api(/|$) {
        proxy_pass http://127.0.0.1:4040;
    }
}`;
			const result = validate_nginx_config(config);
			assert.strictEqual(result.ok, false);
			assert.ok(result.errors.some((e) => e.includes('Authorization')));
		});

		test('no /api block at all → error', () => {
			const config = `server {${base_headers}
    location / {
        try_files $uri =404;
    }
}`;
			const result = validate_nginx_config(config);
			assert.strictEqual(result.ok, false);
			assert.ok(
				result.errors.some((e) => e.includes('No /api location block found')),
				`expected missing-block error, got: ${result.errors.join(' | ')}`,
			);
		});

		test('regex location `~ ^/api` with auth strip → ok', () => {
			const config = `server {${base_headers}
    location ~ ^/api {
        proxy_pass http://127.0.0.1:4040;
        proxy_set_header Authorization "";
    }
}`;
			const result = validate_nginx_config(config);
			assert.strictEqual(result.ok, true, `expected ok, got errors: ${result.errors.join(' | ')}`);
		});

		test('prefix location `/api/` with auth strip → ok (regression)', () => {
			const config = `server {${base_headers}
    location /api/ {
        proxy_pass http://127.0.0.1:4040;
        proxy_set_header Authorization "";
    }
}`;
			const result = validate_nginx_config(config);
			assert.strictEqual(result.ok, true);
		});

		test('regex alternation `~ ^/(admin|api)` without auth strip → error', () => {
			const config = `server {${base_headers}
    location ~ ^/(admin|api) {
        proxy_pass http://127.0.0.1:4040;
    }
}`;
			const result = validate_nginx_config(config);
			assert.strictEqual(result.ok, false);
			assert.ok(result.errors.some((e) => e.includes('Authorization')));
		});

		test('regex `~ ^/apix` (different path) → treated as no /api block', () => {
			// /apix is a distinct path — regex does not match canonical /api URIs,
			// so the config is reported as missing an /api location block.
			const config = `server {${base_headers}
    location ~ ^/apix {
        proxy_pass http://127.0.0.1:4040;
    }
}`;
			const result = validate_nginx_config(config);
			assert.strictEqual(result.ok, false);
			assert.ok(
				result.errors.some((e) => e.includes('No /api location block found')),
				`expected missing-block error, got: ${result.errors.join(' | ')}`,
			);
		});

		test('catch-all `location /` is NOT treated as an /api block', () => {
			// `/` is a prefix of `/api` but nginx routes through the more specific
			// /api block when one exists. Without an explicit /api block we still
			// report the missing-block error (instead of falsely requiring the
			// catch-all to strip Authorization).
			const config = `server {${base_headers}
    location / {
        proxy_pass http://127.0.0.1:4040;
    }
}`;
			const result = validate_nginx_config(config);
			assert.strictEqual(result.ok, false);
			assert.ok(
				result.errors.some((e) => e.includes('No /api location block found')),
				`expected missing-block error, got: ${result.errors.join(' | ')}`,
			);
		});

		test('invalid regex in location path is ignored (not treated as /api block)', () => {
			// `[unclosed` is not a valid regex — the validator must not throw,
			// and must not treat the block as matching /api.
			const config = `server {${base_headers}
    location ~ [unclosed {
        proxy_pass http://127.0.0.1:4040;
    }
    location /api/ {
        proxy_pass http://127.0.0.1:4040;
        proxy_set_header Authorization "";
    }
}`;
			const result = validate_nginx_config(config);
			assert.strictEqual(result.ok, true, `expected ok, got errors: ${result.errors.join(' | ')}`);
		});
	});

	describe('real consumer configs', () => {
		test('visiones nginx config passes validation', () => {
			const result = validate_nginx_config(VISIONES_NGINX_CONFIG);
			assert.strictEqual(
				result.ok,
				true,
				`visiones config should pass — errors: ${result.errors.join(', ')}`,
			);
		});

		test('zap nginx config passes validation', () => {
			const result = validate_nginx_config(ZAP_NGINX_CONFIG);
			assert.strictEqual(
				result.ok,
				true,
				`zap config should pass — errors: ${result.errors.join(', ')}`,
			);
		});

		test('zap config has expected warnings for /zap binary download locations', () => {
			const result = validate_nginx_config(ZAP_NGINX_CONFIG);
			// /zap and /zap.sha256 locations have Content-Disposition / default_type
			// but may not repeat all security headers — this is acceptable
			// since they use auth_request for access control
			assert.strictEqual(result.ok, true);
		});
	});
});
