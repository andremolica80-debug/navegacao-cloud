import { setTimeout as sleep } from 'node:timers/promises';

const DIRECT_TIMEOUT_MS = 6000;
const MAX_BODY_BYTES = 256 * 1024;
const RETRY_STATUS = new Set([500, 502, 503, 504]);
const NETWORK_ERRORS = new Set(['EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']);
const CHALLENGE_MARKERS = /\/cdn-cgi\/challenge-platform\/|id=["']challenge-form["']|class=["'][^"']*\b(?:cf-turnstile|g-recaptcha|h-captcha)\b|challenges\.cloudflare\.com\/turnstile\/|(?:www\.google\.com|www\.recaptcha\.net)\/recaptcha\/api\.js|(?:js\.)?hcaptcha\.com\/1\/api\.js/i;
export const SESSION_TIMEOUT_MS = 25000;

export class RunError extends Error {
  constructor(code) {
    super(code);
    this.name = 'RunError';
    this.code = code;
  }
}

export function resultCode(error) {
  return error instanceof RunError ? error.code : 'unexpected_error';
}

function validateUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new RunError('invalid_registered_url');
  }
  return url;
}

export function assertAllowedRequest(task, url, method) {
  const allowed = [task.url, ...(task.resources ?? [])];
  return ['GET', 'HEAD'].includes(method) && allowed.some((item) => validateUrl(item).href === url);
}

export function assertResponse(status, mitigated, text = '') {
  if (mitigated === 'challenge' || CHALLENGE_MARKERS.test(text)) {
    throw new RunError('challenge_requires_authorized_access');
  }
  if (status >= 300 && status < 400) throw new RunError('redirect_not_allowed');
  if (status === 429) throw new RunError('rate_limited');
  if (status === 401 || status === 403) throw new RunError('access_denied');
  if (status < 200 || status >= 300) throw new RunError('target_http_error');
}

async function readBounded(response) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) throw new RunError('response_too_large');
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function readDirect(task, { fetchImpl = fetch, delay = sleep } = {}) {
  const url = validateUrl(task.url);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(DIRECT_TIMEOUT_MS),
      });
    } catch (error) {
      const retryable = error?.name === 'TimeoutError' || NETWORK_ERRORS.has(error?.cause?.code);
      if (!retryable || attempt === 2) throw new RunError('direct_network_error');
      await delay(300);
      continue;
    }

    const mitigated = response.headers.get('cf-mitigated');
    let body = '';
    try {
      // Some challenge pages use an error status without a mitigation header.
      body = await readBounded(response);
    } catch (error) {
      assertResponse(response.status, mitigated);
      throw error instanceof RunError ? error : new RunError('direct_read_error');
    }
    if (RETRY_STATUS.has(response.status) && attempt === 1) {
      if (mitigated === 'challenge' || CHALLENGE_MARKERS.test(body)) {
        throw new RunError('challenge_requires_authorized_access');
      }
      await delay(300);
      continue;
    }

    assertResponse(response.status, mitigated, body);
    const contentType = response.headers.get('content-type') ?? '';
    if (task.kind === 'json') {
      if (!contentType.includes('json')) throw new RunError('unexpected_content_type');
      let data;
      try {
        data = JSON.parse(body);
      } catch {
        throw new RunError('invalid_json');
      }
      const value = task.field.split('.').reduce((item, key) => item?.[key], data);
      if (!task.allowedValues.includes(value)) throw new RunError('unexpected_api_response');
      return { mode: 'api', status: response.status, attempt, value };
    }

    if (!contentType.includes('text/html')) throw new RunError('unexpected_content_type');
    if (task.kind === 'html' && !body.includes(task.marker)) throw new RunError('expected_content_missing');
    return { mode: 'direct', status: response.status, attempt };
  }
}

export async function runTask(task, options) {
  if (options.remoteSmoke) return options.browser(task, 'browserless', options);

  const direct = await readDirect(task, options);
  if (task.kind !== 'browser') return direct;

  try {
    return await options.browser(task, 'runner', options);
  } catch (error) {
    if (resultCode(error) !== 'runner_browser_unavailable' || !task.allowBrowserless || !options.allowRemote) {
      throw error;
    }
    return options.browser(task, 'browserless', options);
  }
}

export function browserlessEndpoint(token, region = 'sfo') {
  if (!new Set(['sfo', 'lon', 'ams']).has(region)) throw new RunError('invalid_browserless_region');
  const endpoint = new URL('wss://production-' + region + '.browserless.io/chromium/playwright');
  endpoint.searchParams.set('token', token);
  endpoint.searchParams.set('timeout', String(SESSION_TIMEOUT_MS));
  return endpoint.href;
}

export async function checkBrowserlessAccess(env, fetchImpl = fetch) {
  if (env.BROWSERLESS_ENABLED !== 'true') throw new RunError('browserless_disabled');
  if (env.BROWSERLESS_FREE_CONFIRMED !== 'true') throw new RunError('browserless_free_plan_unconfirmed');
  const token = env.BROWSERLESS_TOKEN?.trim();
  if (!token) throw new RunError('browserless_token_missing');

  // The usage endpoint is read-only and creates no browser session.
  const url = new URL('https://api.browserless.io/v1/account/usage');
  url.searchParams.set('token', token);
  let response;
  try {
    response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(7000) });
  } catch {
    throw new RunError('browserless_usage_unavailable');
  }
  await response.body?.cancel().catch(() => {});
  if (response.status === 401 || response.status === 403) throw new RunError('browserless_token_rejected');
  if (!response.ok) throw new RunError('browserless_usage_unavailable');
  return token;
}
