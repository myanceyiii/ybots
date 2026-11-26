import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timerHosts } from '../server/dist/systemd-timer-hosts.js';

test('this server comes first, then the configured machines', () => {
  const hosts = timerHosts({ CONNECTOR_SCAN_HOSTS: 'build-host host3,host4' }, 'host02');
  assert.deepEqual(hosts.map((h) => h.id), ['local', 'build-host', 'host3', 'host4']);
  assert.equal(hosts[0].label, 'This server (host02)');
});

test('SYSTEMD_TIMER_HOSTS wins over the scanner list, and self names are dropped', () => {
  const hosts = timerHosts({ CONNECTOR_SCAN_HOSTS: 'a b', SYSTEMD_TIMER_HOSTS: 'host1 host2 host3', SYSTEMD_TIMER_SELF: 'host2' }, 'host02');
  assert.deepEqual(hosts.map((h) => h.id), ['local', 'host1', 'host3']);
});

test('unsafe, duplicate and reserved names never become ssh targets', () => {
  const hosts = timerHosts({ SYSTEMD_TIMER_HOSTS: 'ok-host $(id) -oProxyCommand=x bad..host local localhost OK-HOST 192.168.1.5 a;b' }, 'srv');
  assert.deepEqual(hosts.map((h) => h.id), ['local', 'ok-host', '192.168.1.5']);
});
