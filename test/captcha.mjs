import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
import { runnerProxy } from '../src/browser.mjs';

const fixtures = [
  {
    name: 'turnstile',
    // Chaves de teste públicas. https://developers.cloudflare.com/turnstile/troubleshooting/testing/
    script: 'https://challenges.cloudflare.com/turnstile/v0/api.js',
    selector: 'cf-turnstile',
    key: '1x00000000000000000000AA',
    secret: '1x0000000000000000000000000000000AA',
    verify: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    fixtureToken: 'XXXX.DUMMY.TOKEN.XXXX',
  },
  {
    name: 'recaptcha-v2',
    // Chaves de teste públicas. https://developers.google.com/recaptcha/docs/faq/
    script: 'https://www.google.com/recaptcha/api.js',
    selector: 'g-recaptcha',
    key: '6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI',
    secret: '6LeIxAcTAAAAAGG-vFI1TnRWxMZNFuojJ4WifJWe',
    verify: 'https://www.google.com/recaptcha/api/siteverify',
    fixtureToken: 'fixture-response',
    checkbox: true,
  },
];

async function verify(fixture, token) {
  const response = await fetch(fixture.verify, {
    method: 'POST',
    body: new URLSearchParams({ secret: fixture.secret, response: token }),
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok || (await response.json()).success !== true) throw new Error('verification failed');
}

if (process.argv.includes('--service-only')) {
  for (const fixture of fixtures) {
    try {
      await verify(fixture, fixture.fixtureToken);
      console.log(JSON.stringify({ fixture: fixture.name, ok: true, stage: 'siteverify-fixture' }));
    } catch {
      console.log(JSON.stringify({ fixture: fixture.name, ok: false, stage: 'siteverify-fixture' }));
      process.exitCode = 1;
    }
  }
} else {
  await testWidgets();
}

async function testWidgets() {
  const server = createServer((request, response) => {
    const fixture = fixtures.find(({ name }) => request.url === '/' + name);
    if (!fixture) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end([
      '<!doctype html><title>Teste de integração CAPTCHA</title>',
      '<script>function done(token) { document.querySelector("#result").value = token; }</script>',
      '<input id="result" type="hidden">',
      '<script async defer src="' + fixture.script + '"></script>',
      '<div class="' + fixture.selector + '" data-sitekey="' + fixture.key + '" data-callback="done"></div>',
    ].join('\n'));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  let browser;

  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
      proxy: runnerProxy(),
      timeout: 8000,
    });
    for (const fixture of fixtures) {
      const page = await browser.newPage();
      let stage = 'widget';
      try {
        await page.goto(base + '/' + fixture.name, { waitUntil: 'domcontentloaded', timeout: 10000 });
        if (fixture.checkbox) {
          const frame = page.frameLocator('iframe[title="reCAPTCHA"]');
          await frame.locator('#recaptcha-anchor').click({ timeout: 12000 });
        }
        const token = await page.waitForFunction(() => document.querySelector('#result').value || false,
          undefined, { timeout: 15000 }).then((handle) => handle.jsonValue());
        stage = 'siteverify';
        await verify(fixture, token);
        console.log(JSON.stringify({ fixture: fixture.name, ok: true, stage }));
      } catch {
        console.log(JSON.stringify({ fixture: fixture.name, ok: false, stage }));
        process.exitCode = 1;
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
