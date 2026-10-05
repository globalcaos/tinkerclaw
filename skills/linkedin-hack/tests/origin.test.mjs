// Unit tests for the origin pin. These import the module directly — the CLI router is
// behind a main guard, so importing it runs no command and writes no file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const { LINKEDIN_ORIGIN, assertLinkedInUrl, isLinkedInUrl, buildUrl, isLoopbackAddr } = await import(
  join(HERE, '..', 'scripts', 'linkedin.mjs')
);

test('the pinned origin is exactly one https host', () => {
  assert.equal(LINKEDIN_ORIGIN, 'https://www.linkedin.com');
});

test('assertLinkedInUrl accepts the real origin', () => {
  assert.equal(assertLinkedInUrl('https://www.linkedin.com/feed/'), 'https://www.linkedin.com/feed/');
  // A default port is normalised away, not treated as a different origin.
  assert.equal(assertLinkedInUrl('https://www.linkedin.com:443/feed/'), 'https://www.linkedin.com/feed/');
});

test('assertLinkedInUrl refuses look-alikes, other schemes and other ports', () => {
  for (const bad of [
    'https://www.linkedin.com.evil.example/feed/', // suffix look-alike
    'https://linkedin.com.evil.example/feed/',
    'https://wwwXlinkedin.com/feed/',
    'https://evil.example/?x=https://www.linkedin.com', // origin is evil.example
    'http://www.linkedin.com/feed/', // plain http
    'https://www.linkedin.com:8443/feed/', // non-default port
    'https://linkedin.com/feed/', // bare apex, not www
    'https://api.linkedin.com/v2/me', // sibling subdomain
    'file:///etc/passwd',
    'javascript:alert(1)',
    'not a url',
  ]) {
    assert.throws(() => assertLinkedInUrl(bad), /refusing/i, `should have refused: ${bad}`);
    assert.equal(isLinkedInUrl(bad), false, `isLinkedInUrl should be false: ${bad}`);
  }
});

test('buildUrl resolves a bare Voyager path to a same-origin relative target', () => {
  assert.deepEqual(buildUrl('/me'), {
    url: 'https://www.linkedin.com/voyager/api/me',
    rel: '/voyager/api/me',
  });
  assert.equal(buildUrl('me').rel, '/voyager/api/me');
  assert.equal(buildUrl('/me', { count: 3 }).rel, '/voyager/api/me?count=3');
});

test('buildUrl refuses an absolute URL for any other host', () => {
  for (const bad of [
    'https://evil.example/voyager/api/me',
    'https://www.linkedin.com.evil.example/voyager/api/me',
    'http://www.linkedin.com/voyager/api/me',
  ]) {
    assert.throws(() => buildUrl(bad), /refusing a target outside/i, `should have refused: ${bad}`);
  }
});

test('buildUrl accepts an absolute URL on the pinned origin', () => {
  assert.equal(buildUrl('https://www.linkedin.com/voyager/api/me').rel, '/voyager/api/me');
});

test('buildUrl keeps the call inside /voyager/api/', () => {
  assert.throws(() => buildUrl('https://www.linkedin.com/feed/'), /outside \/voyager\/api\//);
});

test('a protocol-relative path cannot escape to another host', () => {
  // '//evil.example/x' must stay a PATH on linkedin.com, not become an origin.
  const { url, rel } = buildUrl('//evil.example/x');
  assert.equal(new URL(url).origin, LINKEDIN_ORIGIN);
  assert.ok(rel.startsWith('/voyager/api/'), rel);
});

test('isLoopbackAddr only accepts loopback', () => {
  for (const ok of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) {
    assert.equal(isLoopbackAddr(ok), true, ok);
  }
  assert.equal(isLoopbackAddr('::ffff:7f00:1'), true, 'URL-normalised mapped loopback');
  for (const no of [
    '0.0.0.0',
    '10.0.0.1',
    '192.168.1.5',
    '93.184.216.34',
    '1270.0.0.1',
    '::2',
    'localhost',
    '127.evil.example',
    '127.0.0.1.nip.io',
    '::ffff:a00:1',
  ]) {
    assert.equal(isLoopbackAddr(no), false, no);
  }
});
