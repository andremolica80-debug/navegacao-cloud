import { appendFile } from 'node:fs/promises';
import { readBrowser } from './browser.mjs';
import { resultCode, runTask, RunError } from './navigation.mjs';
import { tasks } from './tasks.mjs';

const env = process.env;
const input = process.argv[2] ?? env.NAV_TASK ?? 'direct-smoke';
const remoteSmoke = input === 'browserless-smoke';
const task = tasks.get(remoteSmoke ? 'browser-smoke' : input);
const controller = new AbortController();

function stop() {
  controller.abort();
}

process.once('SIGINT', stop);
process.once('SIGTERM', stop);

const started = Date.now();
let report;
try {
  if (!task) throw new RunError('unknown_task');
  const result = await runTask(task, {
    allowRemote: env.NAV_ALLOW_BROWSERLESS === 'true',
    browser: readBrowser,
    env,
    remoteSmoke,
    signal: controller.signal,
  });
  if (controller.signal.aborted) throw new RunError('interrupted');
  report = { ok: true, task: input, ...result };
} catch (error) {
  report = { ok: false, task: task ? input : 'unknown', code: resultCode(error) };
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}

report.durationMs = Date.now() - started;
const json = JSON.stringify(report);
console.log(json);
if (env.GITHUB_STEP_SUMMARY) {
  const summary = ['## Navegação', '', '~~~json', json, '~~~', ''].join('\n');
  await appendFile(env.GITHUB_STEP_SUMMARY, summary).catch(() => {
    console.log(JSON.stringify({ warning: 'summary_unavailable' }));
  });
}
