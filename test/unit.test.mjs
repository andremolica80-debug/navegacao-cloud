import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertAllowedRequest, assertResponse, browserlessEndpoint, checkBrowserlessAccess,
  readDirect, runTask, RunError, SESSION_TIMEOUT_MS,
} from '../src/navigation.mjs';
import { tasks } from '../src/tasks.mjs';

const htmlTask = tasks.get('direct-smoke');
const html = (body, status = 200, headers = {}) => new Response(body, {
  status, headers: { 'content-type': 'text/html', ...headers },
});
const direct = (response) => readDirect(htmlTask, { fetchImpl: async () => response });

test('uses direct HTTPS with manual redirects', async () => {
  const result = await readDirect(htmlTask, { fetchImpl: async (url, options) => {
    assert.equal(url.href, htmlTask.url);
    assert.equal(options.redirect, 'manual');
    assert.ok(options.signal);
    return html(htmlTask.marker);
  } });
  assert.deepEqual(result, { mode: 'direct', status: 200, attempt: 1 });
});

test('returns only the expected public API field', async () => {
  const task = tasks.get('api-smoke');
  const result = await readDirect(task, { fetchImpl: async () => Response.json({
    status: { indicator: 'none' }, other: 'unused value',
  }) });
  assert.deepEqual(result, { mode: 'api', status: 200, attempt: 1, value: 'none' });
});

test('retries a transient HTTP failure once', async () => {
  let calls = 0;
  const result = await readDirect(htmlTask, {
    fetchImpl: async () => ++calls === 1 ? html('unavailable', 503) : html(htmlTask.marker),
    delay: async () => {},
  });
  assert.equal(result.attempt, 2);
  assert.equal(calls, 2);
});

test('does not retry or switch browsers on explicit challenges', async () => {
  for (const response of [
    html('Verify', 503, { 'cf-mitigated': 'challenge' }),
    html('<div class="cf-turnstile"></div>'),
    html('<div class="g-recaptcha"></div>'),
    html('<div class="h-captcha"></div>'),
  ]) {
    let calls = 0;
    await assert.rejects(readDirect(htmlTask, {
      fetchImpl: async () => { calls += 1; return response; },
    }), { code: 'challenge_requires_authorized_access' });
    assert.equal(calls, 1);
  }
});

test('stops on denied, rate-limited and redirect responses', async () => {
  await assert.rejects(direct(html('', 403)), { code: 'access_denied' });
  await assert.rejects(direct(html('', 429)), { code: 'rate_limited' });
  await assert.rejects(direct(html('', 302)), { code: 'redirect_not_allowed' });
});

test('rejects incomplete and oversized direct content', async () => {
  await assert.rejects(direct(html('wrong content')), { code: 'expected_content_missing' });
  await assert.rejects(direct(html('x'.repeat(256 * 1024 + 1))), { code: 'response_too_large' });
});

test('allows only exact registered reads', () => {
  const task = { url: htmlTask.url, resources: ['https://example.org/style.css'] };
  assert.equal(assertAllowedRequest(task, task.url, 'GET'), true);
  assert.equal(assertAllowedRequest(task, task.resources[0], 'HEAD'), true);
  assert.equal(assertAllowedRequest(task, task.url, 'POST'), false);
  assert.equal(assertAllowedRequest(task, 'https://example.com/?a=b', 'GET'), false);
  assert.equal(assertAllowedRequest(task, 'https://example.org/login', 'GET'), false);
  assert.throws(() => assertAllowedRequest({ url: 'http://example.com/' }, task.url, 'GET'),
    { code: 'invalid_registered_url' });
});

test('refuses a Cloudflare mitigation header regardless of HTTP status', () => {
  assert.throws(() => assertResponse(200, 'challenge', 'ordinary looking page'),
    { code: 'challenge_requires_authorized_access' });
});

test('has no paid connection options or customizable credential destination', () => {
  const token = 'fixture-not-a-secret+&';
  const url = new URL(browserlessEndpoint(token, 'lon'));
  assert.equal(url.origin, 'wss://production-lon.browserless.io');
  assert.equal(url.pathname, '/chromium/playwright');
  assert.deepEqual([...url.searchParams], [['token', token], ['timeout', String(SESSION_TIMEOUT_MS)]]);
  assert.throws(() => browserlessEndpoint(token, 'example.com'), { code: 'invalid_browserless_region' });
  assert.ok(SESSION_TIMEOUT_MS < 30000);
});

test('checks remote opt-in, free plan confirmation and credential before requesting access', async () => {
  const neverFetch = async () => assert.fail('unexpected provider request');
  await assert.rejects(checkBrowserlessAccess({}, neverFetch), { code: 'browserless_disabled' });
  await assert.rejects(checkBrowserlessAccess({ BROWSERLESS_ENABLED: 'true' }, neverFetch),
    { code: 'browserless_free_plan_unconfirmed' });
  const env = { BROWSERLESS_ENABLED: 'true', BROWSERLESS_FREE_CONFIRMED: 'true' };
  await assert.rejects(checkBrowserlessAccess(env, neverFetch), { code: 'browserless_token_missing' });
  env.BROWSERLESS_TOKEN = 'fixture-not-a-secret';
  await assert.rejects(checkBrowserlessAccess(env, async () => new Response(null, { status: 401 })),
    { code: 'browserless_token_rejected' });
  await assert.rejects(checkBrowserlessAccess(env, async () => new Response(null, { status: 503 })),
    { code: 'browserless_usage_unavailable' });
  const token = await checkBrowserlessAccess(env, async (url, options) => {
    assert.equal(url.origin + url.pathname, 'https://api.browserless.io/v1/account/usage');
    assert.equal(options.redirect, 'error');
    assert.equal(url.searchParams.get('token'), env.BROWSERLESS_TOKEN);
    return Response.json({});
  });
  assert.equal(token, env.BROWSERLESS_TOKEN);
});

test('calls only one remote browser for an explicit connection smoke test', async () => {
  const browser = async (_task, mode) => ({ mode });
  const result = await runTask(tasks.get('browser-smoke'), { remoteSmoke: true, browser });
  assert.deepEqual(result, { mode: 'browserless' });
});

test('falls back only on explicitly eligible runner unavailability', async () => {
  const task = { ...tasks.get('browser-smoke'), allowBrowserless: true };
  function browserFailingWith(code, modes) {
    return async (_task, mode) => {
      modes.push(mode);
      if (mode === 'runner') throw new RunError(code);
      return { mode };
    };
  }
  const modes = [];
  const result = await runTask(task, {
    browser: browserFailingWith('runner_browser_unavailable', modes),
    allowRemote: true,
    fetchImpl: async () => html('allowed'),
  });
  assert.deepEqual(result, { mode: 'browserless' });
  assert.deepEqual(modes, ['runner', 'browserless']);

  for (const [code, allowRemote] of [
    ['runner_browser_unavailable', false],
    ['challenge_requires_authorized_access', true],
  ]) {
    const invocations = [];
    await assert.rejects(runTask(task, {
      browser: browserFailingWith(code, invocations),
      allowRemote,
      fetchImpl: async () => html('allowed'),
    }), { code });
    assert.deepEqual(invocations, ['runner']);
  }
});
