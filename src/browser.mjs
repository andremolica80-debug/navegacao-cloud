import { assertAllowedRequest, assertResponse, browserlessEndpoint, checkBrowserlessAccess, RunError } from './navigation.mjs';

export function runnerProxy(env = process.env) {
  const value = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  if (!value) return undefined;
  const url = new URL(value);
  return {
    server: url.origin,
    username: decodeURIComponent(url.username) || undefined,
    password: decodeURIComponent(url.password) || undefined,
    bypass: env.NO_PROXY || env.no_proxy,
  };
}

export async function readBrowser(task, mode, { env = process.env, allowRemote = false, signal } = {}) {
  // Playwright debug output can include the authenticated connection URL.
  delete process.env.DEBUG;
  delete process.env.PWDEBUG;
  delete process.env.NODE_DEBUG;
  const { chromium } = await import('playwright-core');

  let browser;
  try {
    if (mode === 'browserless') {
      if (!allowRemote) throw new RunError('browserless_run_not_enabled');
      const token = await checkBrowserlessAccess(env);
      const endpoint = browserlessEndpoint(token, env.BROWSERLESS_REGION || 'sfo');
      signal?.throwIfAborted();
      browser = await chromium.connect(endpoint, { timeout: 8000 });
    } else {
      const { BROWSERLESS_TOKEN: _token, ...browserEnv } = process.env;
      browser = await chromium.launch({
        executablePath: env.CHROMIUM_EXECUTABLE_PATH || undefined,
        env: browserEnv,
        timeout: 8000,
      });
    }
  } catch (error) {
    if (error instanceof RunError) throw error;
    throw new RunError(mode === 'runner' ? 'runner_browser_unavailable' : 'browserless_connection_failed');
  }

  let closePromise;
  const close = () => {
    closePromise ??= browser.close().then(() => true, () => false);
    return closePromise;
  };
  const deadline = AbortSignal.timeout(20000);
  const executionSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  executionSignal.addEventListener('abort', close, { once: true });
  let closed = false;
  let deniedNavigation;
  try {
    executionSignal.throwIfAborted();
    const context = await browser.newContext({
      serviceWorkers: 'block',
      acceptDownloads: false,
      proxy: mode === 'runner' ? runnerProxy(env) : undefined,
    });
    context.setDefaultTimeout(5000);
    await context.routeWebSocket('**/*', (socket) => socket.close());
    await context.route('**/*', async (route) => {
      const request = route.request();
      const nav = request.isNavigationRequest();
      if (!assertAllowedRequest(task, request.url(), request.method())) {
        if (nav) deniedNavigation = 'unapproved_navigation';
        await route.abort();
        return;
      }
      let response;
      try {
        // Fetch exactly one hop. Chromium must never receive a redirect to follow.
        response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 5000 });
        if (response.status() >= 300 && response.status() < 400) {
          if (nav) deniedNavigation = 'redirect_not_allowed';
          await route.abort();
          return;
        }
        const headers = response.headers();
        // Playwright has already decompressed the body. Let Chromium recalculate its length.
        delete headers['content-encoding'];
        delete headers['content-length'];
        delete headers['transfer-encoding'];
        await route.fulfill({ status: response.status(), headers, body: await response.body() });
      } catch {
        await route.abort().catch(() => {});
      } finally {
        await response?.dispose().catch(() => {});
      }
    });

    const page = await context.newPage();
    const response = await page.goto(task.url, { waitUntil: 'domcontentloaded', timeout: 8000 });
    if (!response) throw new RunError('browser_response_missing');
    assertResponse(response.status(), await response.headerValue('cf-mitigated'), await page.content());

    const locator = page.locator(task.selector).first();
    await locator.waitFor({ state: 'visible' }).catch(() => {
      throw new RunError('expected_content_missing');
    });
    if (deniedNavigation) throw new RunError(deniedNavigation);
    if (page.url() !== new URL(task.url).href) throw new RunError('unapproved_navigation');
    const content = await page.content();
    assertResponse(response.status(), await response.headerValue('cf-mitigated'), content);
    if ((await locator.textContent())?.trim() !== task.expectedText) throw new RunError('expected_content_missing');
    return { mode, status: response.status(), attempt: 1 };
  } catch (error) {
    if (signal?.aborted) throw new RunError('interrupted');
    if (deadline.aborted) throw new RunError('browser_timeout');
    if (deniedNavigation) throw new RunError(deniedNavigation);
    throw error instanceof RunError ? error : new RunError('browser_navigation_failed');
  } finally {
    await Promise.race([
      close().then((didClose) => { closed = didClose; }),
      new Promise((resolve) => {
        const timer = setTimeout(resolve, 2500);
        timer.unref();
      }),
    ]);
    executionSignal.removeEventListener('abort', close);
    if (!closed) console.log(JSON.stringify({ warning: 'browser_close_unconfirmed', mode }));
  }
}
