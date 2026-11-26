// The live stream can be resumed: every event carries a number, a reconnect with the last one seen gets
// exactly what it missed, and anything the server can no longer replay says so (resumed: false).
// Hermetic: a throwaway server and a fake Hermes.
import assert from 'node:assert/strict';
import { startServer, runner, until, sleep } from './lib/server.mjs';

const { test, done } = runner();
const s = await startServer({ name: 'events-resume' });

/** Open the stream and collect what arrives. `after` goes as ?after=, `header` as Last-Event-ID. */
function listen(token, { after, header } = {}) {
  const ctl = new AbortController();
  const got = [];
  const ready = (async () => {
    const res = await fetch(`${s.BASE}/api/events${after ? `?after=${encodeURIComponent(after)}` : ''}`, { headers: { authorization: `Bearer ${token}`, ...(header ? { 'last-event-id': header } : {}) }, signal: ctl.signal });
    assert.equal(res.status, 200);
    (async () => {
      const dec = new TextDecoder();
      let buf = '';
      try {
        for await (const chunk of res.body) {
          buf += dec.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i); buf = buf.slice(i + 2);
            const id = /^id: (.*)$/m.exec(block)?.[1] ?? null;
            const data = /^data: (.*)$/m.exec(block)?.[1];
            if (data) got.push({ id, ev: JSON.parse(data) });
          }
        }
      } catch { /* closed */ }
    })();
  })();
  return { got, ready, close: () => ctl.abort() };
}

try {
  const me = await s.signIn('owner@example.com');
  const bot = (await me.api('POST', '/bots', { name: 'Fenwick' })).json.bot ?? (await me.api('GET', '/bots')).json.bots[0];
  const rename = (name) => me.api('PATCH', `/bots/${bot.id}`, { name });

  let lastSeen;
  await test('hello names the build and every event carries a number', async () => {
    const a = listen(me.token); await a.ready;
    await until('hello', async () => a.got.length >= 1);
    const hello = a.got[0];
    assert.equal(hello.ev.type, 'hello');
    assert.equal(hello.ev.resumed, false);
    assert.ok('commit' in hello.ev && 'web' in hello.ev);
    assert.match(hello.id, /^[a-z0-9]+\.\d+$/);
    await rename('Fenwick 2');
    await until('the rename', async () => a.got.some((x) => x.ev.type === 'bot' && x.ev.bot.name === 'Fenwick 2'));
    const ids = a.got.filter((x) => x.id).map((x) => Number(x.id.split('.')[1]));
    assert.deepEqual(ids, [...ids].sort((x, y) => x - y), 'numbers only go up');
    lastSeen = a.got.filter((x) => x.id).at(-1).id;
    a.close();
  });

  await test('a reconnect with the last number gets what it missed, once, and nothing older', async () => {
    await rename('Fenwick 3');
    await rename('Fenwick 4');
    await sleep(100);
    for (const how of ['after', 'header']) {
      const b = listen(me.token, { [how]: lastSeen }); await b.ready;
      await until('the missed events', async () => b.got.some((x) => x.ev.type === 'bot' && x.ev.bot.name === 'Fenwick 4'));
      assert.equal(b.got[0].ev.type, 'hello');
      assert.equal(b.got[0].ev.resumed, true, how);
      const names = b.got.filter((x) => x.ev.type === 'bot').map((x) => x.ev.bot.name);
      assert.ok(!names.includes('Fenwick 2'), 'nothing it had already seen');
      assert.deepEqual(names.filter((n) => n === 'Fenwick 3' || n === 'Fenwick 4'), ['Fenwick 3', 'Fenwick 4']);
      // Live events keep arriving after the replay, without repeats.
      await rename(`Fenwick 5 ${how}`);
      await until('a live event', async () => b.got.some((x) => x.ev.type === 'bot' && x.ev.bot.name === `Fenwick 5 ${how}`));
      const seen = b.got.filter((x) => x.id && x.ev.type !== 'hello').map((x) => x.id);
      assert.equal(new Set(seen).size, seen.length, 'no event twice');
      b.close();
    }
  });

  await test('a number from another run, a number from the future and nonsense all start afresh', async () => {
    for (const after of ['zzzz.3', `${lastSeen.split('.')[0]}.99999999`, 'banana', '1']) {
      const c = listen(me.token, { after }); await c.ready;
      await until('hello', async () => c.got.length >= 1);
      assert.equal(c.got[0].ev.resumed, false, after);
      c.close();
    }
  });

  await test('another account is never sent this account\'s events on resume', async () => {
    const other = await s.signIn('someone@example.com');
    const d = listen(other.token, { after: lastSeen }); await d.ready;
    await until('hello', async () => d.got.length >= 1);
    await sleep(200);
    assert.ok(!d.got.some((x) => x.ev.type === 'bot'), 'none of the owner\'s bot events');
    d.close();
  });
} finally {
  await s.stop();
}
done();
