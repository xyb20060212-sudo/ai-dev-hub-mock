import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const server = new URL('../src/stdio-server.mjs', import.meta.url);
const init = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'offline-test', version: '1' } },
};
const ready = { jsonrpc: '2.0', method: 'notifications/initialized' };
const request = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
const line = (message) => `${JSON.stringify(message)}\n`;

async function run(t, chunks) {
  // Spawn only the existing Node executable and this local stdio fixture.
  const { fileURLToPath } = await import('node:url');
  const child = spawn(process.execPath, [fileURLToPath(server)], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['pipe', 'pipe', 'pipe'],
  });
  let timedOut = false;
  const deadline = setTimeout(() => { timedOut = true; child.kill(); }, 5000);
  t.after(() => {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) child.kill();
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  child.stdin.on('error', () => { /* Exit assertions below report an early close. */ });
  const completion = once(child, 'close');
  for (const chunk of chunks) {
    child.stdin.write(chunk);
    // Ensure the fragmented-input test also exercises separate writes.
    await new Promise((resolve) => setImmediate(resolve));
  }
  child.stdin.end();
  const [code, signal] = await completion;
  clearTimeout(deadline);
  assert.equal(timedOut, false, 'child must terminate after EOF');
  assert.equal(signal, null);
  assert.equal(code, 0);
  assert.equal(Buffer.concat(stderr).toString('utf8'), '');
  const raw = Buffer.concat(stdout).toString('utf8');
  if (raw) assert.ok(raw.endsWith('\n'));
  const messages = raw.trim() ? raw.trim().split('\n').map((entry) => JSON.parse(entry)) : [];
  for (const message of messages) {
    assert.equal(message.jsonrpc, '2.0');
    assert.ok(Object.hasOwn(message, 'id'));
    assert.notEqual(Object.hasOwn(message, 'result'), Object.hasOwn(message, 'error'));
  }
  return { messages, raw };
}

test('A07 initialize, notification, discovery, calls and ping round-trip over stdio', async (t) => {
  const { messages } = await run(t, [[
    line(init), line(ready), line(request(2, 'tools/list', {})),
    line(request(3, 'tools/call', { name: 'hub_list_projects', arguments: {} })),
    line(request(4, 'tools/call', { name: 'hub_get_project_status', arguments: { project_id: 'mock-cash' } })),
    line(request(5, 'tools/call', { name: 'hub_get_capabilities', arguments: {} })),
    line(request(6, 'ping', {})),
  ].join('')]);
  assert.deepEqual(messages.map((message) => message.id), [1, 2, 3, 4, 5, 6]);
  assert.equal(messages[0].result.protocolVersion, '2024-11-05');
  assert.deepEqual(messages[0].result.capabilities, { tools: {} });
  assert.equal(messages[1].result.tools.length, 3);
  const projects = JSON.parse(messages[2].result.content[0].text);
  assert.equal(projects.length, 4);
  assert.ok(projects.every((project) => project.simulated === true));
  assert.equal(JSON.parse(messages[3].result.content[0].text).project_id, 'mock-cash');
  assert.equal(JSON.parse(messages[4].result.content[0].text).network_enabled, false);
  assert.deepEqual(messages[5].result, {});
});

test('A08 initialization gates, explicit version range and unknown method errors', async (t) => {
  const { messages } = await run(t, [[
    line(request(0, 'tools/list', {})), line(init),
    line(request(2, 'tools/list', {})), line(request(7, 'initialize', init.params)), line(ready),
    line(request(3, 'unknown/method', {})),
    line(request(4, 'tools/call', { name: 'run_command', arguments: {} })),
    line(request(5, 'tools/list', { cursor: 'unsupported' })),
  ].join('')]);
  assert.deepEqual(messages.map((message) => message.error?.code ?? 'ok'), [
    -32000, 'ok', -32000, -32000, -32601, -32602, -32602,
  ]);
});

test('A09 malformed JSON, invalid envelopes and batches have sanitized errors', async (t) => {
  const { messages, raw } = await run(t, [[
    '{malicious-secret\n', '[]\n', 'null\n', line({ jsonrpc: '1.0', id: 2, method: 'ping' }),
    line(request(true, 'ping', {})), line({ jsonrpc: '2.0', id: 3, method: 'ping', extra: 'private-marker' }),
    line(request(4, 'ping', null)), line(request(5, 'ping', [])),
    line(request('valid-string-id', 'ping', {})),
  ].join('')]);
  assert.deepEqual(messages.map((message) => message.error?.code ?? 'ok'), [
    -32700, -32600, -32600, -32600, -32600, -32600, -32602, -32602, 'ok',
  ]);
  assert.equal(messages.at(-1).id, 'valid-string-id');
  assert.doesNotMatch(raw, /malicious-secret|private-marker|stack|[A-Z]:\\/u);
});

test('A10 malicious tool input is refused with no echo or notification responses', async (t) => {
  const forbidden = JSON.parse('{"__proto__":{"polluted":true}}');
  const notifications = [
    { jsonrpc: '2.0', method: 'unknown/method', params: { secret: 'private-marker' } },
    { jsonrpc: '2.0', method: 'tools/call', params: { name: 'run_command', arguments: {} } },
  ];
  const values = [
    [], 42, { project_id: 'C:\\private-marker' }, { project_id: '../private-marker' },
    { project_id: 'mock-app\u0000' }, { project_id: 'mock-app', extra: true },
    { ...forbidden, project_id: 'mock-app' }, { constructor: 'private-marker' },
  ];
  const { messages, raw } = await run(t, [
    line(init) + line(ready) + notifications.map(line).join('')
    + values.map((argumentsValue, index) => line(request(index + 2, 'tools/call', {
      name: 'hub_get_project_status', arguments: argumentsValue,
    }))).join('') + line(request(99, 'ping', {})),
  ]);
  assert.equal(messages.length, values.length + 2);
  for (const message of messages.slice(1, -1)) assert.equal(message.result.isError, true);
  assert.deepEqual(messages.at(-1).result, {});
  assert.doesNotMatch(raw, /private-marker|polluted|__proto__|stack|[A-Z]:\\/u);
  assert.equal(Object.prototype.polluted, undefined);
});

test('A11 request bound rejects oversized lines and resumes, including fragmented input', async (t) => {
  const oversized = line(request(80, 'ping', { secret: 'x'.repeat(9000) }));
  const good = Buffer.from(line(request(81, 'ping', {})));
  const encoded = JSON.stringify(request(83, 'ping', {}));
  const atLimit = encoded + ' '.repeat(8192 - Buffer.byteLength(encoded));
  const unicodeOversize = line(request(84, 'ping', { text: '界'.repeat(3000) }));
  assert.ok(unicodeOversize.length < 8192 && Buffer.byteLength(unicodeOversize) > 8192);
  const { messages, raw } = await run(t, [
    oversized.slice(0, 4000), oversized.slice(4000, 8500), oversized.slice(8500),
    good.subarray(0, 5), good.subarray(5, 13), good.subarray(13),
    Buffer.from([0xff, 10]), line(request(82, 'ping', {})).replace('\n', '\r\n'),
    atLimit + '\n', atLimit + ' \n', unicodeOversize, line(request(85, 'ping', {})),
  ]);
  assert.deepEqual(messages.map((message) => message.error?.code ?? 'ok'), [
    -32600, 'ok', -32700, 'ok', 'ok', -32600, -32600, 'ok',
  ]);
  assert.deepEqual(messages.filter((message) => message.result).map((message) => message.id), [81, 82, 83, 85]);
  assert.doesNotMatch(raw, /xxxx|secret/u);
});

test('A12 EOF, final non-newline request and notification-only processes exit cleanly', async (t) => {
  assert.deepEqual((await run(t, [])).messages, []);
  assert.deepEqual((await run(t, [line(ready)])).messages, []);
  const { messages } = await run(t, [JSON.stringify(request(1, 'ping', {}))]);
  assert.deepEqual(messages, [{ jsonrpc: '2.0', id: 1, result: {} }]);
  const oversized = await run(t, ['x'.repeat(9000)]);
  assert.equal(oversized.messages.length, 1);
  assert.equal(oversized.messages[0].error.message, 'Request too large.');
});

test('B05 each isolated handshake honestly returns the sole supported version', async (t) => {
  for (const protocolVersion of ['2024-11-05', '2025-11-25', '2099-01-01']) {
    const initialization = structuredClone(init);
    initialization.params.protocolVersion = protocolVersion;
    const { messages } = await run(t, [
      line(initialization) + line(ready) + line(request(2, 'tools/list', {})),
    ]);
    assert.equal(messages[0].result.protocolVersion, '2024-11-05');
    assert.deepEqual(messages[0].result.capabilities, { tools: {} });
    assert.equal(messages[1].result.tools.length, 3);
  }
});

test('B06 safe open capabilities are ignored and never echoed or activated', async (t) => {
  const initialization = structuredClone(init);
  initialization.params.capabilities = {
    roots: { listChanged: true }, sampling: {}, experimental: { demo: {} },
    extension: { note: 'private-marker', values: [true, null, 1] },
  };
  const { messages, raw } = await run(t, [line(initialization) + line(ready)
    + line(request(2, 'tools/call', { name: 'hub_get_capabilities' }))]);
  assert.deepEqual(messages[0].result.capabilities, { tools: {} });
  assert.deepEqual(JSON.parse(messages[1].result.content[0].text), {
    simulated: true, prototype_version: '0.1.0', protocol_versions: ['2024-11-05'],
    read_only: true, network_enabled: false, real_projects_connected: false,
    codex_execution_enabled: false,
  });
  assert.doesNotMatch(raw, /private-marker/u);
});

test('B07 invalid initialization does not advance state and retains sanitized errors', async (t) => {
  const invalidParams = [
    { ...init.params, protocolVersion: '' }, { ...init.params, protocolVersion: null },
    { ...init.params, protocolVersion: 1 }, { ...init.params, protocolVersion: 'invalid\n' },
    { capabilities: {}, clientInfo: init.params.clientInfo },
    { ...init.params, capabilities: [] }, { ...init.params, capabilities: { sampling: false } },
    { ...init.params, capabilities: { roots: { listChanged: 'yes' } } },
    { ...init.params, capabilities: JSON.parse('{"__proto__":{}}') },
    { ...init.params, clientInfo: { name: 'x', version: '1', title: 'private-marker' } },
    { ...init.params, clientInfo: { name: 'x'.repeat(81), version: '1' } },
  ];
  for (const params of invalidParams) {
    const { messages, raw } = await run(t, [line({ ...init, id: 0, params })
      + line(init) + line(ready) + line(request(2, 'tools/list', {}))]);
    assert.deepEqual(messages[0].error, { code: -32602, message: 'Invalid params.' });
    assert.equal(messages[1].result.protocolVersion, '2024-11-05');
    assert.equal(messages[2].result.tools.length, 3);
    assert.doesNotMatch(raw, /private-marker|__proto__|stack/u);
  }
});

test('B08 safe notification metadata advances readiness while invalid notifications stay silent', async (t) => {
  const legalNotification = { ...ready, params: { _meta: { demo: true }, extension: ['safe'] } };
  let deep = {};
  for (let index = 0; index < 9; index++) deep = { next: deep };
  for (const params of [null, [], { text: 'x'.repeat(2049) }, deep,
    { _meta: JSON.parse('{"constructor":{}}') }]) {
    const invalidNotification = { ...ready, params };
    const { messages } = await run(t, [line(init) + line(invalidNotification)
      + line(request(2, 'tools/list', {}))
      + line(request(3, 'notifications/initialized', {}))
      + line(legalNotification) + line(request(4, 'tools/list', {}))]);
    assert.deepEqual(messages.map((message) => message.id), [1, 2, 3, 4]);
    assert.equal(messages[1].error.code, -32000);
    assert.equal(messages[2].error.code, -32601);
    assert.equal(messages[3].result.tools.length, 3);
  }
});

test('B09 tools/list supports omitted or empty params without pretending to paginate', async (t) => {
  const { messages } = await run(t, [line(init) + line(ready)
    + line(request(2, 'tools/list')) + line(request(3, 'tools/list', {}))
    + line(request(4, 'tools/list', { cursor: 'never-issued' }))]);
  for (const message of messages.slice(1, 3)) {
    assert.equal(message.result.tools.length, 3);
    assert.equal(Object.hasOwn(message.result, 'nextCursor'), false);
  }
  assert.equal(messages[3].error.code, -32602);
});

test('B10 only truly missing arguments default to empty; handlers remain strict', async (t) => {
  const calls = [
    { name: 'hub_list_projects' }, { name: 'hub_get_capabilities' },
    { name: 'hub_get_project_status' },
    ...[null, [], 'text', 1, true].map((argumentsValue) => ({
      name: 'hub_list_projects', arguments: argumentsValue,
    })),
    { name: 'hub_list_projects', arguments: { extra: true } },
    { name: 'hub_list_projects', arguments: {}, extra: true },
  ];
  const { messages } = await run(t, [line(init) + line(ready)
    + calls.map((params, index) => line(request(index + 2, 'tools/call', params))).join('')]);
  assert.equal(JSON.parse(messages[1].result.content[0].text).length, 4);
  assert.equal(JSON.parse(messages[2].result.content[0].text).simulated, true);
  for (const message of messages.slice(3, -1)) {
    assert.deepEqual(message.result, {
      isError: true, content: [{ type: 'text', text: 'Invalid tool arguments.' }],
    });
  }
  assert.deepEqual(messages.at(-1).error, { code: -32602, message: 'Invalid params.' });
});

test('B11 all successful tools preserve fixed fabricated values and the closed tool set', async (t) => {
  const ids = ['mock-app', 'mock-web', 'mock-otp', 'mock-cash'];
  const statuses = ['simulated-ready', 'simulated-review', 'simulated-idle', 'simulated-paused'];
  const { messages, raw } = await run(t, [line(init) + line(ready)
    + ids.map((project_id, index) => line(request(index + 2, 'tools/call', {
      name: 'hub_get_project_status', arguments: { project_id },
    }))).join('')
    + line(request(6, 'tools/list', {}))]);
  for (let index = 0; index < ids.length; index++) {
    const result = JSON.parse(messages[index + 1].result.content[0].text);
    assert.equal(result.project_id, ids[index]);
    assert.equal(result.status, statuses[index]);
    assert.equal(result.simulated, true);
    assert.deepEqual(Object.keys(result).sort(), ['name', 'project_id', 'simulated', 'status']);
  }
  assert.deepEqual(messages.at(-1).result.tools.map((tool) => tool.name), [
    'hub_list_projects', 'hub_get_project_status', 'hub_get_capabilities',
  ]);
  assert.doesNotMatch(raw, /[A-Z]:\\|read_file|run_command|write_file/u);
});

test('B12 a simulated client explicitly declines fallback before EOF; no tools are sent', async (t) => {
  const { fileURLToPath } = await import('node:url');
  const child = spawn(process.execPath, [fileURLToPath(server)], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['pipe', 'pipe', 'pipe'],
  });
  let timedOut = false;
  const deadline = setTimeout(() => { timedOut = true; child.kill(); }, 5000);
  t.after(() => {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) child.kill();
  });
  let stdout = '';
  let stderr = '';
  let decision = 'NO_RESPONSE';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.on('error', () => {});
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (decision === 'NO_RESPONSE' && stdout.includes('\n')) {
      try {
        const response = JSON.parse(stdout.slice(0, stdout.indexOf('\n')));
        decision = response.id === 1 && response.result?.protocolVersion === '2024-11-05'
          ? 'CLIENT_EXPLICITLY_DECLINED_FALLBACK' : 'INITIALIZATION_FAULT';
      } catch { decision = 'INITIALIZATION_FAULT'; }
      child.stdin.end();
    }
  });
  const completed = once(child, 'close');
  const newer = structuredClone(init);
  newer.params.protocolVersion = '2025-11-25';
  const sentMethods = [newer.method];
  child.stdin.write(line(newer));
  const [code, signal] = await completed;
  clearTimeout(deadline);
  assert.equal(timedOut, false, 'a timeout is not a client rejection');
  assert.equal(signal, null, 'a killed process is not a client rejection');
  assert.equal(code, 0);
  assert.equal(decision, 'CLIENT_EXPLICITLY_DECLINED_FALLBACK');
  assert.deepEqual(sentMethods, ['initialize']);
  assert.equal(stdout.trim().split('\n').length, 1);
  assert.equal(stderr, '');
});

test('Tunnel discovery then a second handshake can call the mock over the same stdio child', async (t) => {
  const secondInit = {
    ...init.params,
    protocolVersion: '2025-11-25',
    clientInfo: { name: 'offline-chat', version: '1' },
  };
  const call = { name: 'hub_get_capabilities', arguments: {} };
  const { messages } = await run(t, [[
    line(init), line(ready), line(request(2, 'tools/list', {})),
    line(request(3, 'initialize', { ...secondInit, protocolVersion: '' })),
    line(request(4, 'tools/list', {})),
    line(request(5, 'initialize', secondInit)),
    line(request(6, 'tools/call', call)), line(ready),
    line(request(7, 'tools/call', call)),
  ].join('')]);

  assert.deepEqual(messages.map((message) => message.id), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(messages[4], { jsonrpc: '2.0', id: 5, result: messages[0].result });
  assert.equal(messages[4].result.protocolVersion, '2024-11-05');
  assert.deepEqual(messages[1].result.tools.map((tool) => tool.name).sort(), [
    'hub_get_capabilities', 'hub_get_project_status', 'hub_list_projects',
  ]);
  assert.deepEqual(messages[2].error, { code: -32602, message: 'Invalid params.' });
  assert.deepEqual(messages[3].result, messages[1].result);
  assert.deepEqual(messages[5].error, { code: -32000, message: 'Initialization required.' });
  assert.equal(JSON.parse(messages[6].result.content[0].text).simulated, true);
});

test('MCP request metadata on tools/list is bounded and ignored', async (t) => {
  const metadata = { progressToken: 12, 'offline/fixture': { note: 'offline-meta-marker' } };
  const params = [
    { _meta: metadata },
    { _meta: [] },
    { _meta: JSON.parse('{"nested":{"__proto__":{"unsafe":true}}}') },
    { _meta: { progressToken: false } },
    { _meta: { note: 'x'.repeat(2049) } },
    { _meta: metadata, cursor: 'never-issued' },
  ];
  const { messages, raw } = await run(t, [
    line(init) + line(ready)
    + params.map((entry, index) => line(request(index + 2, 'tools/list', entry))).join(''),
  ]);

  assert.deepEqual(messages[1].error ?? null, null);
  assert.deepEqual(messages[1].result.tools.map((tool) => tool.name).sort(), [
    'hub_get_capabilities', 'hub_get_project_status', 'hub_list_projects',
  ]);
  assert.equal(Object.hasOwn(messages[1].result, 'nextCursor'), false);
  for (const response of messages.slice(2)) {
    assert.deepEqual(response.error, { code: -32602, message: 'Invalid params.' });
  }
  assert.doesNotMatch(raw, /offline-meta-marker|__proto__|never-issued/u);
});

test('MCP request metadata on tools/call stays separate from the tool arguments', async (t) => {
  const call = { name: 'hub_get_capabilities', arguments: {} };
  const metadata = { progressToken: 'offline-meta-marker', 'offline/fixture': ['demo'] };
  const params = [
    { ...call, _meta: metadata },
    { ...call, _meta: null },
    { ...call, _meta: metadata, extra: true },
    { ...call, _meta: metadata, arguments: { _meta: metadata } },
  ];
  const { messages, raw } = await run(t, [
    line(init) + line(ready)
    + params.map((entry, index) => line(request(index + 2, 'tools/call', entry))).join(''),
  ]);

  assert.deepEqual(messages[1].error ?? null, null);
  assert.equal(JSON.parse(messages[1].result.content[0].text).simulated, true);
  for (const response of messages.slice(2, 4)) {
    assert.deepEqual(response.error, { code: -32602, message: 'Invalid params.' });
  }
  assert.deepEqual(messages[4].result, {
    isError: true, content: [{ type: 'text', text: 'Invalid tool arguments.' }],
  });
  assert.doesNotMatch(raw, /offline-meta-marker/u);
});
