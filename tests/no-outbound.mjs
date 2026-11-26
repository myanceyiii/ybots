// Loaded into the server that tests/security.mjs starts (node --import): connections to anything
// but this machine fail at once and are named on stderr, so a check can never reach a real service
// by accident. (The Composio SDK, for one, asks the npm registry for its latest version at start.)
import net from 'node:net';

const here = (host) => host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
const connect = net.Socket.prototype.connect;

net.Socket.prototype.connect = function (...args) {
  // connect(options), connect(port, host), connect(path), or Node's own pre-sorted [options, callback].
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  let host = null; // null = a local pipe, not a network address
  if (first && typeof first === 'object') host = first.path ? null : String(first.host ?? 'localhost');
  else if (typeof first === 'number' || /^\d+$/.test(String(first))) host = typeof args[1] === 'string' ? args[1] : 'localhost';
  if (host !== null && !here(host)) {
    console.error(`[no-outbound] blocked a connection to ${host}`);
    process.nextTick(() => this.destroy(new Error(`tests/no-outbound.mjs: connections to ${host} are blocked`)));
    return this;
  }
  return connect.apply(this, args);
};
