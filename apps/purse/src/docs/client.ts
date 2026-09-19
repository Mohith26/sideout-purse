/** Browser code served verbatim; no framework, storage, analytics or third-party requests. */
export const docsClient = String.raw`
'use strict';
const element = (id) => document.getElementById(id);
const examples = JSON.parse(element('examples').textContent);
let keys;
const refs = {};
const selected = () => examples[Number(element('example').value)];
function fill(value) {
  let text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  for (const [placeholder, actual] of Object.entries(refs)) text = text.split(placeholder).join(actual);
  return text;
}
function choose() {
  const example = selected();
  element('path').value = fill(example.request.path);
  element('body').value = example.request.body === null ? '' : fill(example.request.body);
  element('method').textContent = example.request.method;
  element('expected').textContent = JSON.stringify(example.response.body, null, 2);
}
function remember(data) {
  if (!data || typeof data !== 'object') return;
  if (typeof data.id === 'string' && /^[a-z]+_/.test(data.id)) refs[data.id.split('_')[0] + '_<id>'] = data.id;
  if (typeof data.token === 'string') refs['<embed-token>'] = data.token;
  if (typeof data.payoutHash === 'string') refs['<sha256>'] = data.payoutHash;
  if (typeof data.previewedAt === 'string') refs['<instant>'] = data.previewedAt;
  for (const value of Object.values(data)) if (value && typeof value === 'object') remember(value);
}
async function send(path, method, body, token) {
  const url = new URL(path, location.origin);
  if (!path.startsWith('/v1/') || url.origin !== location.origin || url.username || url.password) throw new Error('Use a /v1/ path on this API origin.');
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (method !== 'GET') headers['Idempotency-Key'] = crypto.randomUUID();
  if (body && method !== 'GET') { JSON.parse(body); headers['Content-Type'] = 'application/json'; }
  element('request').textContent = method + ' ' + url.pathname + url.search + '\n' + Object.entries(headers).map(([k,v]) => k + ': ' + v).join('\n') + '\n\n' + (body || '');
  const response = await fetch(url, { method, headers, ...(body && method !== 'GET' ? { body } : {}), credentials: 'same-origin', redirect: 'error' });
  const text = await response.text();
  element('response').textContent = 'HTTP ' + response.status + '\n' + Array.from(response.headers).map(([k,v]) => k + ': ' + v).join('\n') + '\n\n' + text;
  if (!response.ok) throw new Error('Request returned HTTP ' + response.status + '. See the raw response.');
  return text ? JSON.parse(text).data : null;
}
async function busy(button, operation) {
  button.disabled = true;
  element('message').textContent = 'Sending…';
  try { await operation(); element('message').textContent = 'Complete.'; }
  catch (error) { element('message').textContent = error instanceof Error ? error.message : String(error); }
  finally { button.disabled = false; }
}
element('mint').addEventListener('click', (event) => busy(event.currentTarget, async () => {
  keys = await send('/v1/sandbox/keys', 'POST', '{}');
  element('keys').textContent = JSON.stringify(keys, null, 2);
  element('run').disabled = false;
}));
element('run').addEventListener('click', (event) => busy(event.currentTarget, async () => {
  const example = selected();
  const path = element('path').value;
  const publicRequest = path === '/v1/sandbox/keys' || path === '/v1/health' || path === '/v1/status';
  const embedRequest = path.startsWith('/v1/embed/') && path !== '/v1/embed/tokens';
  const token = publicRequest ? undefined : embedRequest ? keys.publishableKey : keys.secretKey;
  const data = await send(path, example.request.method, element('body').value, token);
  remember(data);
  if (path === '/v1/sandbox/keys') { keys = data; element('keys').textContent = JSON.stringify(keys, null, 2); }
}));
element('example').addEventListener('change', choose);
choose();
`;
