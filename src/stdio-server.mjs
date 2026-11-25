import {
  assertObject, assertProtocolRecord, callTool, InputError, listTools, validateInitializeParams,
} from './handlers.mjs';
import { PROTOCOL_VERSION, PROTOTYPE_VERSION } from './mock-data.mjs';

// shortcut: bounded newline JSON only; official client compatibility needs separate review.
const MAX_LINE_BYTES = 8192;
const decoder = new TextDecoder('utf-8', { fatal: true });
let state = 'new';
let pending = Buffer.alloc(0);
let discarding = false;

class RpcError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function smallText(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function emptyParams(params) {
  assertObject(params === undefined ? {} : params, []);
}

function assertToolParams(params, allowed, required = []) {
  assertObject(params, [...allowed, '_meta'], required);
  if (!Object.hasOwn(params, '_meta')) return;

  const metadata = params._meta;
  assertProtocolRecord(metadata);
  if (Object.hasOwn(metadata, 'progressToken')) {
    const token = metadata.progressToken;
    if (typeof token !== 'string' && typeof token !== 'number') throw new InputError();
  }
}

function route(method, params) {
  if (method === 'ping') { emptyParams(params); return {}; }
  if (method === 'initialize') {
    // shortcut: sequential fake sessions on one child; isolate sessions for concurrent clients.
    if (state === 'initializing') throw new RpcError(-32000, 'Already initialized.');
    validateInitializeParams(params);
    state = 'initializing';
    return {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'offline-hub-mock', version: PROTOTYPE_VERSION },
    };
  }
  if (method !== 'tools/list' && method !== 'tools/call') {
    throw new RpcError(-32601, 'Method not found.');
  }
  if (state !== 'ready') throw new RpcError(-32000, 'Initialization required.');
  if (method === 'tools/list') {
    assertToolParams(params === undefined ? {} : params, []);
    return { tools: listTools() };
  }
  assertToolParams(params, ['name', 'arguments'], ['name']);
  if (!listTools().some((tool) => tool.name === params.name)) throw new InputError();
  try {
    const args = Object.hasOwn(params, 'arguments') ? params.arguments : {};
    return { content: [{ type: 'text', text: JSON.stringify(callTool(params.name, args)) }] };
  } catch (error) {
    if (!(error instanceof InputError)) throw error;
    return { isError: true, content: [{ type: 'text', text: 'Invalid tool arguments.' }] };
  }
}

function receive(line) {
  let message;
  try { message = JSON.parse(decoder.decode(line)); }
  catch { fail(null, -32700, 'Parse error.'); return; }
  try {
    assertObject(message, ['jsonrpc', 'id', 'method', 'params'], ['jsonrpc', 'method']);
    if (message.jsonrpc !== '2.0' || !smallText(message.method, 64)) throw new InputError();
    if (Object.hasOwn(message, 'id') && message.id !== null
      && !(typeof message.id === 'number' && Number.isFinite(message.id))
      && !smallText(message.id, 128)) throw new InputError();
  } catch { fail(null, -32600, 'Invalid request.'); return; }

  const notification = !Object.hasOwn(message, 'id');
  if (notification) {
    // Valid notifications, including unknown ones, never receive responses.
    if (message.method === 'notifications/initialized' && state === 'initializing') {
      try {
        assertProtocolRecord(message.params === undefined ? {} : message.params);
        state = 'ready';
      } catch { /* Ignore invalid notification. */ }
    }
    return;
  }
  try {
    send({ jsonrpc: '2.0', id: message.id, result: route(message.method, message.params) });
  } catch (error) {
    if (error instanceof RpcError) fail(message.id, error.code, error.message);
    else if (error instanceof InputError) fail(message.id, -32602, 'Invalid params.');
    else fail(message.id, -32603, 'Internal error.');
  }
}

function consume(chunk) {
  let offset = 0;
  while (offset < chunk.length) {
    const newline = chunk.indexOf(10, offset);
    const end = newline === -1 ? chunk.length : newline;
    const piece = chunk.subarray(offset, end);
    if (!discarding) {
      if (pending.length + piece.length > MAX_LINE_BYTES) {
        pending = Buffer.alloc(0);
        discarding = true;
        fail(null, -32600, 'Request too large.');
      } else {
        pending = Buffer.concat([pending, piece]);
      }
    }
    if (newline === -1) break;
    if (!discarding) {
      const line = pending.at(-1) === 13 ? pending.subarray(0, -1) : pending;
      receive(line);
    }
    pending = Buffer.alloc(0);
    discarding = false;
    offset = newline + 1;
  }
}

process.stdin.on('data', consume);
process.stdin.on('end', () => {
  if (!discarding && pending.length) receive(pending);
  pending = Buffer.alloc(0);
});
process.stdin.on('error', () => {
  process.stderr.write('Input stream unavailable.\n');
  process.exitCode = 1;
  process.stdin.destroy();
});
process.stdout.on('error', () => {
  process.exitCode = 1;
  process.stdin.destroy();
});
