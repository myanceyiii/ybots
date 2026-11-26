// Run by tests/security.mjs, in the throwaway server's environment (never on its own: it opens the
// database that environment names). Asks the built server code what policyFor decides for each
// call it is given and prints the answers as one line of JSON.
//   node tests/policy-probe.mjs '{"email":"…","policies":[[tool,mode],…],"cases":[[toolName,args],…]}'
const { email, policies = [], cases } = JSON.parse(process.argv[2]);
const { db } = await import('../server/dist/db.js');
const { policyFor } = await import('../server/dist/agent/tools.js');
const userId = db.prepare('SELECT id FROM users WHERE lower(email)=lower(?)').get(email).id;
// The stored policies exist only while the cases are answered.
for (const [tool, mode] of policies) db.prepare('INSERT OR REPLACE INTO policies(user_id,tool,mode) VALUES (?,?,?)').run(userId, tool, mode);
const answers = cases.map(([name, args]) => policyFor(userId, name, args));
for (const [tool] of policies) db.prepare('DELETE FROM policies WHERE user_id=? AND tool=?').run(userId, tool);
console.log(`ANSWERS ${JSON.stringify(answers)}`);
process.exit(0);
