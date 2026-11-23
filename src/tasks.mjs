// Adicione somente destinos com autorização para automação.
// URLs são exatas. Use a URL canônica, pois redirecionamentos são recusados.
export const tasks = new Map([
  ['direct-smoke', {
    url: 'https://httpbingo.org/html',
    kind: 'html',
    marker: 'Herman Melville - Moby-Dick',
  }],
  ['api-smoke', {
    url: 'https://www.githubstatus.com/api/v2/status.json',
    kind: 'json',
    field: 'status.indicator',
    allowedValues: ['none', 'minor', 'major', 'critical', 'maintenance'],
  }],
  ['browser-smoke', {
    url: 'https://httpbingo.org/html',
    kind: 'browser',
    selector: 'h1',
    expectedText: 'Herman Melville - Moby-Dick',
  }],
]);
