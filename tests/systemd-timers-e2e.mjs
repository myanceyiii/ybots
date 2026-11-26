import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleft-timer-e2e-'));
const port = 24000 + Math.floor(Math.random() * 1000), base = `http://127.0.0.1:${port}`;
const secret = crypto.randomBytes(32).toString('hex');
const server = spawn(process.execPath, ['server/dist/index.js'], { env: { PATH:process.env.PATH, HOME:dir, PORT:String(port), APP_URL:base, SERVER_URL:base, SESSION_SECRET:secret, DB_PATH:path.join(dir,'db.sqlite'), ENGINES_DIR:path.join(dir,'engines'), HERMES_BIN:'/bin/false', HERMES_URL:'http://127.0.0.1:1', HERMES_HOME_PRIMARY:path.join(dir,'hermes'), APPS_CONFIG:path.join(dir,'apps.json'), BOTHQ_NO_SCHEDULER:'1', DEV_LOGIN:'1', OWNER_EMAIL:'owner@example.com', MAINTAINER_BOTS:'Doug' }, stdio:'ignore' });
const pause = (ms) => new Promise(r => setTimeout(r,ms));
try {
  for (let i=0;;i++) { try { await fetch(`${base}/api/health`); break; } catch { if (i===100) throw Error('server failed to start'); await pause(100); } }
  const key = crypto.createHmac('sha256',secret).update('owner-login').digest('hex');
  const login = await fetch(`${base}/api/auth/dev`, { method:'POST', headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({email:'owner@example.com'}) });
  assert.equal(login.status,200);
  const cookie=login.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
  const request=async (method,p,body)=>{const res=await fetch(`${base}/api${p}`,{method,headers:{cookie,origin:base,'content-type':'application/json'},body:body ? JSON.stringify(body):undefined});return {status:res.status,json:await res.json()};};
  const bot=(await request('GET','/bots')).json.bots.find(b=>b.isPrimary);
  assert.ok(bot); console.log('test bot',bot.name,bot.isPrimary,bot.engine);
  const list=await request('GET',`/bots/${bot.id}/systemd-timers`); assert.equal(list.status,200); assert.ok(Array.isArray(list.json.hosts)); assert.equal(list.json.hosts[0].host,'local'); assert.match(list.json.hosts[0].label,/^This server/);
  const probe=await request('GET',`/bots/${bot.id}/systemd-timers?probe=1`); assert.equal(probe.status,200); assert.deepEqual(probe.json.hosts,[]);
  assert.equal((await request('POST',`/bots/${bot.id}/systemd-timers/change`,{host:'local',unit:'x.timer;bad',action:'enable'})).status,400);
  const pending=request('POST',`/bots/${bot.id}/systemd-timers/change`,{host:'local',unit:'nonexistent-test.timer',action:'enable'});
  let card;
  for(let i=0;i<100;i++){ const rows=(await request('GET',`/bots/${bot.id}/rows`)).json.rows; card=rows.find(r=>r.body.card==='approval'); if(card)break; await pause(100); }
  assert.ok(card,'change produced a genuine approval card');
  assert.equal(card.body.canAlways,false,'timer control must never offer persistent approval');
  assert.equal(card.body.args.unit,'nonexistent-test.timer');
  assert.equal((await request('POST',`/approvals/${card.body.approvalId}`,{decision:'deny',digest:card.body.digest})).status,200);
  assert.equal((await pending).status,409,'denied action fails closed');
  console.log('Timer API: read, invalid target, non-persistent approval and denial passed');
} finally { server.kill('SIGTERM'); }
