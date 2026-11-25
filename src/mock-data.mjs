// Every value is a fabricated fixture, never a query of a real project.
export const PROJECTS = Object.freeze([
  ['mock-app', 'Mock App', 'simulated-ready'],
  ['mock-web', 'Mock Website', 'simulated-review'],
  ['mock-otp', 'Mock OTP', 'simulated-idle'],
  ['mock-cash', 'Mock Wallet', 'simulated-paused'],
].map(([project_id, name, status]) => Object.freeze({
  project_id, name, status, simulated: true,
})));

export const PROTOCOL_VERSION = '2024-11-05';
export const PROTOTYPE_VERSION = '0.1.0';
