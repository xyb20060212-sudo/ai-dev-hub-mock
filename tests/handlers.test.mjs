import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertProtocolRecord, callTool, InputError, listTools, validateInitializeParams,
} from '../src/handlers.mjs';

const ids = ['mock-app', 'mock-web', 'mock-otp', 'mock-cash'];

test('A01 tool discovery exposes exactly three read-only schemas', () => {
  const tools = listTools();
  assert.deepEqual(tools.map((tool) => tool.name), [
    'hub_list_projects', 'hub_get_project_status', 'hub_get_capabilities',
  ]);
  for (const tool of tools) {
    assert.ok(tool.description.length > 20);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.deepEqual(tool.annotations, {
      readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true,
    });
  }
  assert.deepEqual(tools[1].inputSchema.properties.project_id.enum, ids);
  tools[0].annotations.readOnlyHint = false;
  assert.equal(listTools()[0].annotations.readOnlyHint, true);
});

test('A02 only fabricated project summaries and fixed statuses are returned', () => {
  const projects = callTool('hub_list_projects', {});
  assert.deepEqual(projects.map((project) => project.project_id), ids);
  for (const project of projects) {
    assert.deepEqual(Object.keys(project).sort(), ['name', 'project_id', 'simulated', 'status']);
    assert.equal(project.simulated, true);
    assert.match(project.status, /^simulated-/u);
    assert.deepEqual(callTool('hub_get_project_status', { project_id: project.project_id }), project);
  }
  projects[0].status = 'changed';
  assert.equal(callTool('hub_get_project_status', { project_id: ids[0] }).status, 'simulated-ready');
});

test('A03 capabilities disclose disabled connections, networking and execution', () => {
  assert.deepEqual(callTool('hub_get_capabilities', {}), {
    simulated: true, prototype_version: '0.1.0', protocol_versions: ['2024-11-05'],
    read_only: true, network_enabled: false, real_projects_connected: false,
    codex_execution_enabled: false,
  });
});

test('A04 handlers reject nonobjects, extra fields, hidden fields and accessors', () => {
  for (const name of listTools().map((tool) => tool.name)) {
    for (const value of [null, undefined, [], 1, 'text', true, { extra: true }]) {
      assert.throws(() => callTool(name, value), InputError);
    }
  }
  assert.throws(() => callTool('hub_get_project_status', {}), InputError);
  assert.throws(() => callTool('hub_get_project_status', { project_id: ids[0], extra: true }), InputError);
  assert.throws(() => callTool('hub_list_projects', { [Symbol('field')]: true }), InputError);
  const hidden = Object.defineProperty({}, 'constructor', { value: true });
  assert.throws(() => callTool('hub_list_projects', hidden), InputError);
  const accessor = { get project_id() { assert.fail('Getter must never run'); } };
  assert.throws(() => callTool('hub_get_project_status', accessor), InputError);
});

test('A05 exact ID allowlist rejects traversal, commands, controls and long strings', () => {
  for (const project_id of [
    '../mock-app', '..\\mock-app', '/etc/passwd', 'C:\\private',
    'E:\\private', 'https://invalid.example', 'mock-app; whoami',
    'MOCK-APP', 'mock-app\n', '\u0000', 'x'.repeat(20000), '',
    {}, [], 1, null, '__proto__', 'constructor', 'prototype',
  ]) {
    assert.throws(() => callTool('hub_get_project_status', { project_id }), InputError);
  }
  for (const name of ['read_file', 'run_command', 'write_file', 'start_codex', 'send_task', 'constructor']) {
    assert.throws(() => callTool(name, {}), InputError);
  }
});

test('A06 dangerous keys and inherited arguments are refused without echoing input', () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const args = JSON.parse(`{"${key}":{"polluted":true}}`);
    assert.throws(() => callTool('hub_list_projects', args), {
      name: 'InputError', message: 'Invalid tool name or arguments.',
    });
    assert.throws(() => callTool('hub_get_project_status', { ...args, project_id: ids[0] }), InputError);
  }
  assert.throws(() => callTool('hub_get_project_status', Object.create({ project_id: ids[0] })), InputError);
  assert.equal(Object.prototype.polluted, undefined);
});

const initialization = () => ({
  protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'offline-test', version: '1' },
});

test('B01 nonempty and open capabilities are validated without mutation or activation', () => {
  const params = initialization();
  params.capabilities = {
    roots: { listChanged: true }, sampling: {}, experimental: { demo: { enabled: true } },
    extension: { flags: [true, null, 1], text: 'inert' },
  };
  const original = structuredClone(params);
  assert.doesNotThrow(() => validateInitializeParams(params));
  assert.deepEqual(params, original);
  assert.equal(callTool('hub_get_capabilities', {}).real_projects_connected, false);
  assert.equal(listTools().length, 3);
});

test('B02 malformed initialization preserves strict types and basic clientInfo', () => {
  for (const capabilities of [null, [], 1, { roots: [] }, { sampling: null },
    { roots: { listChanged: 'yes' } }, { experimental: { demo: 1 } }, { extension: true }]) {
    assert.throws(() => validateInitializeParams({ ...initialization(), capabilities }), InputError);
  }
  for (const clientInfo of [null, [], {}, { name: 'x', version: 1 },
    { name: '', version: '1' }, { name: 'x'.repeat(81), version: '1' },
    { name: 'x', version: '1', title: 'not-enabled' }]) {
    assert.throws(() => validateInitializeParams({ ...initialization(), clientInfo }), InputError);
  }
  for (const protocolVersion of [null, 1, '', 'invalid\n', 'x'.repeat(2049)]) {
    assert.throws(() => validateInitializeParams({ ...initialization(), protocolVersion }), InputError);
  }
  const missing = initialization();
  delete missing.protocolVersion;
  assert.throws(() => validateInitializeParams(missing), InputError);
});

test('B03 nested dangerous keys, inherited objects and accessors are refused without getters', () => {
  let getterCalls = 0;
  const accessor = Object.defineProperty({}, 'value', {
    enumerable: true, get() { getterCalls++; return 'never'; },
  });
  const values = [accessor, Object.create({ inherited: true }),
    { [Symbol('field')]: true }, { hidden: undefined }, { invalid: NaN },
    { invalid: () => {} }, { array: new Array(1) }];
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    values.push(JSON.parse(`{"${key}":{}}`));
  }
  for (const value of values) {
    assert.throws(() => assertProtocolRecord({ _meta: value }), InputError);
    const params = initialization();
    params.capabilities = { extension: value };
    assert.throws(() => validateInitializeParams(params), InputError);
  }
  assert.equal(getterCalls, 0);
  assert.equal(Object.prototype.polluted, undefined);
});

test('B04 inert data obeys exact local depth, node, key and string limits', () => {
  function nested(depth) {
    let value = {};
    for (let index = 0; index < depth; index++) value = { next: value };
    return value;
  }
  assert.doesNotThrow(() => assertProtocolRecord(nested(8)));
  assert.throws(() => assertProtocolRecord(nested(9)), InputError);
  assert.doesNotThrow(() => assertProtocolRecord(Object.fromEntries(
    Array.from({ length: 255 }, (_, index) => [`k${index}`, true]),
  )));
  assert.throws(() => assertProtocolRecord(Object.fromEntries(
    Array.from({ length: 256 }, (_, index) => [`k${index}`, true]),
  )), InputError);
  assert.doesNotThrow(() => assertProtocolRecord({ ['k'.repeat(128)]: 'x'.repeat(2048) }));
  assert.throws(() => assertProtocolRecord({ ['k'.repeat(129)]: true }), InputError);
  assert.throws(() => assertProtocolRecord({ text: 'x'.repeat(2049) }), InputError);
  assert.throws(() => assertProtocolRecord({ text: 'bad\u0000' }), InputError);
  assert.doesNotThrow(() => assertProtocolRecord({ values: [null, true, 1, 'safe'] }));
});
