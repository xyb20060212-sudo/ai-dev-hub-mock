import { PROJECTS, PROTOCOL_VERSION, PROTOTYPE_VERSION } from './mock-data.mjs';

export class InputError extends Error {
  constructor() {
    super('Invalid tool name or arguments.');
    this.name = 'InputError';
  }
}

export function assertObject(value, allowed, required = allowed) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InputError();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new InputError();
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (typeof key !== 'string' || !allowed.includes(key)) throw new InputError();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new InputError();
    }
  }
  if (required.some((key) => !Object.hasOwn(value, key))) throw new InputError();
}

const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype']);
const controls = /[\u0000-\u001f\u007f]/u;

function requireRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new InputError();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new InputError();
}

// Local safety policy for inert protocol data, not MCP specification limits.
export function assertProtocolRecord(value) {
  requireRecord(value);
  let nodes = 0;
  function visit(entry, depth) {
    if (++nodes > 256 || depth > 8) throw new InputError();
    if (typeof entry === 'string') {
      if (entry.length > 2048 || controls.test(entry)) throw new InputError();
      return;
    }
    if (entry === null || typeof entry === 'boolean') return;
    if (typeof entry === 'number' && Number.isFinite(entry)) return;
    if (typeof entry !== 'object') throw new InputError();
    const array = Array.isArray(entry);
    if (array) {
      if (Object.getPrototypeOf(entry) !== Array.prototype) throw new InputError();
    } else requireRecord(entry);
    const keys = Reflect.ownKeys(entry);
    if (array && keys.length !== entry.length + 1) throw new InputError();
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string' || key.length > 128 || controls.test(key)
        || forbiddenKeys.has(key)) throw new InputError();
      if (array && (!/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= entry.length)) {
        throw new InputError();
      }
      const descriptor = Object.getOwnPropertyDescriptor(entry, key);
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new InputError();
      visit(descriptor.value, depth + 1);
    }
  }
  visit(value, 0);
}

export function validateInitializeParams(params) {
  assertObject(params, ['protocolVersion', 'capabilities', 'clientInfo']);
  assertProtocolRecord(params);
  if (typeof params.protocolVersion !== 'string' || params.protocolVersion.length === 0) {
    throw new InputError();
  }
  requireRecord(params.capabilities);
  for (const declaration of Object.values(params.capabilities)) requireRecord(declaration);
  if (Object.hasOwn(params.capabilities, 'roots')) {
    const roots = params.capabilities.roots;
    if (Object.hasOwn(roots, 'listChanged') && typeof roots.listChanged !== 'boolean') {
      throw new InputError();
    }
  }
  if (Object.hasOwn(params.capabilities, 'experimental')) {
    for (const declaration of Object.values(params.capabilities.experimental)) requireRecord(declaration);
  }
  assertObject(params.clientInfo, ['name', 'version']);
  for (const field of ['name', 'version']) {
    if (typeof params.clientInfo[field] !== 'string' || params.clientInfo[field].length === 0
      || params.clientInfo[field].length > 80) throw new InputError();
  }
}

const emptySchema = { type: 'object', properties: {}, additionalProperties: false };
const annotations = {
  readOnlyHint: true, destructiveHint: false, openWorldHint: false,
  idempotentHint: true,
};
const tools = [
  {
    name: 'hub_list_projects',
    description: 'List four fabricated project summaries. No real project access.',
    inputSchema: emptySchema,
    annotations,
  },
  {
    name: 'hub_get_project_status',
    description: 'Return a fixed simulated status for one exact allowlisted ID.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', enum: PROJECTS.map((p) => p.project_id) },
      },
      required: ['project_id'],
      additionalProperties: false,
    },
    annotations,
  },
  {
    name: 'hub_get_capabilities',
    description: 'Describe this offline, read-only mock; no execution or connection.',
    inputSchema: emptySchema,
    annotations,
  },
];

export function listTools() {
  return structuredClone(tools);
}

export function callTool(name, args) {
  if (!tools.some((tool) => tool.name === name)) throw new InputError();
  assertObject(args, name === 'hub_get_project_status' ? ['project_id'] : []);
  if (name === 'hub_list_projects') return PROJECTS.map((project) => ({ ...project }));
  if (name === 'hub_get_project_status') {
    const project = PROJECTS.find((entry) => entry.project_id === args.project_id);
    if (!project) throw new InputError();
    return { ...project };
  }
  return {
    simulated: true,
    prototype_version: PROTOTYPE_VERSION,
    protocol_versions: [PROTOCOL_VERSION],
    read_only: true,
    network_enabled: false,
    real_projects_connected: false,
    codex_execution_enabled: false,
  };
}
