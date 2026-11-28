// Web-only preview of every screen with demo data, for screenshot comparison against the design
// references. Not part of the Android app: index.ts only loads it when Platform.OS === 'web'.
import { useState } from 'react';
import { useWindowDimensions, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import type { Bot, Client, Row } from '../src/api';
import { BotSettings } from '../src/screens/BotSettings';
import { Call } from '../src/screens/Call';
import { Chat } from '../src/screens/Chat';
import { Pcs } from '../src/screens/Pcs';
import { Tasks } from '../src/screens/Tasks';
import { Files } from '../src/screens/Files';
import { Pages } from '../src/screens/Pages';
import { Connections } from '../src/screens/Connections';
import { PluginCode } from '../src/screens/PluginCode';
import { Computer } from '../src/screens/Computer';
import { TeachReview } from '../src/screens/TeachReview';
import { CustomLook } from '../src/screens/CustomLook';
import { Home } from '../src/screens/Home';
import { NewBot } from '../src/screens/NewBot';
import { NewGroup } from '../src/screens/NewGroup';
import { SignIn } from '../src/screens/SignIn';
import { Welcome } from '../src/screens/Welcome';
import { DeviceLink } from '../src/screens/DeviceLink';
import { Permissions } from '../src/screens/Permissions';
import { Devices } from '../src/screens/Devices';
import { SystemStatus } from '../src/screens/SystemStatus';
import { Usage } from '../src/screens/Usage';
import { SavedLogins } from '../src/screens/SavedLogins';
import { Activity } from '../src/screens/Activity';
import { BotsComputer } from '../src/screens/BotsComputer';
import { Exchanges } from '../src/screens/Exchanges';
import { setLive, updateLive } from '../src/live';
import { showNeedsYou } from '../src/needsYou';
import { applyScheme, color } from '../src/theme';
import { SplitPane } from '../src/components/SplitPane';
import { A2UI_DEMO } from './a2uiDemo';
import { SideChatChip, SideChatSheet } from '../src/components/SideChats';
import type { SideChat } from '../src/api';
import { History } from '../src/screens/History';
import { Search } from '../src/screens/Search';
import { enqueue, setOutboxAccount } from '../src/outbox';
import { ErrorBoundary, RowGuard } from '../src/components/ErrorBoundary';
import { ConnectionBanner } from '../src/components/ConnectionBanner';
import { Appearance } from '../src/components/BackgroundSettings';
let sendingSet = false;

/** Model badges (server/src/model-badge.ts) as the server sends them. */
const MODEL_OPUS = { id: 'claude-opus-5-5', provider: 'anthropic', effort: 'high', tier: 'heavy', mode: 'auto', fallback: false, short: 'Opus', name: 'Claude Opus 5.5' } as const;
const MODEL_SONNET = { id: 'claude-sonnet-5', provider: 'anthropic', effort: 'medium', tier: 'standard', mode: 'auto', fallback: false, short: 'Sonnet', name: 'Claude Sonnet 5' } as const;
const now = Date.now();
const min = 60_000;
// A call in progress (?screen=call), and one that could not start (?screen=callerror).
const CALL_DEMO = {
  status: 'live', botId: 'robin', muted: false, speaking: true, listening: false, thinking: false, working: null, error: null, startedAt: now - 83_000,
  captions: [
    { id: 'u1', role: 'user', text: 'What do we still need for Saturday?', final: true },
    { id: 'a1', role: 'assistant', text: 'Milk, eggs and the birthday candles. Want me to add them to the pickup order?', final: true },
  ],
} as const;
const CALL_ERROR = { ...CALL_DEMO, status: 'error', speaking: false, captions: [], error: 'Microphone access is off for this app. Allow it in Android settings to talk to your bot.' } as const;
const bot = (id: string, name: string, avatarShape: Bot['avatarShape'], avatarColor: Bot['avatarColor'], lastPreview: string, ago: number, extra: Partial<Bot> = {}): Bot => ({
  id, name, label: name, avatarShape, avatarColor, avatarImageUrl: null, chatColor: avatarColor === 'gray' || avatarColor === 'black' ? 'blue' : avatarColor as Bot['chatColor'], isPrimary: false, kind: 'agent', pinned: false, unread: 0, lastPreview, lastActivityAt: now - ago, ...extra,
}) as Bot;
const BOTS: Bot[] = [
  bot('howard', 'Howard', 'blob', 'violet', 'Nightly backup finished and Host2 disk is at 61%.', 20 * min, { isPrimary: true, pinned: true, unread: 1,
    previewForms: ['Nightly backup finished and Host2 disk is at 61%. Two updates are ready; I need your OK before I restart the gateway.', 'Nightly backup finished and Host2 disk is at 61%', 'Nightly backup finished'] }),
  bot('leonard', 'Leonard', 'teardrop', 'blue', 'You posted last.', 4 * min, { pinned: true, unread: 2, previewBy: 'you' }),
  bot('robin', 'Robin', 'cloud', 'green', 'Grocery pickup is set for 5 PM.', 60 * min, { pinned: true }),
  bot('sheldon', 'Sheldon', 'hex', 'cyan', 'Posted the summary you asked for in #assistants. I will pick up the follow-up when you mention me there.', 90 * min, { outside: { via: 'slack', channelName: 'assistants', status: 'ready', waiting: 0, callUrl: '' } }),
  bot('scout', 'Deal Scout', 'bean', 'brown', 'Found 4 price drops on your list.', 3 * 60 * min),
  bot('chef', 'Meal Planner', 'egg', 'orange', 'Next week’s menu is ready.', 5 * 60 * min),
  bot('inbox', 'Inbox Keeper', 'capsule', 'red', '12 emails filed, 2 need you.', 26 * 60 * min),
  bot('bills', 'Bill Tracker', 'wedge', 'magenta', 'Receipts sorted, one needs a look.', 27 * 60 * min),
  bot('travel', 'Trip Planner', 'squircle', 'blue', 'Pulled 3 flight options.', 3 * 24 * 60 * min),
];
const GROUP = bot('room_family', 'Family desk', 'cloud', 'gray', 'Leonard: Budget looks fine for the trip.', 10 * min, { kind: 'room', label: 'Group' });

let seq = 0;
const row = (body: any, ago: number): Row => ({ seq: ++seq, botId: 'demo', generation: 1, kind: body.type, body, createdAt: now - ago, updatedSeq: 0 });
const msg = (role: 'user' | 'assistant', text: string, ago: number) => row({ type: 'message', role, text }, ago);
// A group chat where you asked one member by @name (?screen=groupchat; ?draft= fills the message box).
const GROUP_ROWS: Row[] = [
  row({ type: 'message', role: 'assistant', text: 'Budget looks fine for the trip.', from: { kind: 'bot', id: 'leonard', name: 'Leonard' } }, 12 * min),
  msg('user', 'Thanks. What about you, @Sheldon? Anything on the calendar that week?', 10 * min),
  row({ type: 'message', role: 'assistant', text: 'Nothing that week. The only hold is the dentist on the 9th.', from: { kind: 'bot', id: 'sheldon', name: 'Sheldon', via: 'slack' } }, 8 * min),
  row({ type: 'message', role: 'assistant', text: 'I can move the grocery pickup to Friday so it is out of the way.', from: { kind: 'bot', id: 'robin', name: 'Robin' } }, 7 * min),
];
const ROWS: Row[] = [
  msg('assistant', 'Here is **today**:\n\n- Grocery pickup at *5 PM*\n- Pay the water bill\n- Call `Dr. Lee` back\n\nMore at [the calendar](https://example.com).', 70 * min),
  msg('assistant', '8 AM routine done. Inbox sorted, 3 unread left.', 62 * min),
  msg('assistant', '### Bills this week\n\n| Bill | Due | Amount |\n|---|---|---:|\n| Power | Dec 3 | $142.10 |\n| Water | Dec 5 | $48.00 |\n\n1. Pay power first\n   - autopay is off\n- [x] Water scheduled\n\nBank sync failed: {"error":{"message":"ITEM_LOGIN_REQUIRED: sign in to Chase again","code":400,"request_id":"abc123"}}', 61.5 * min),
  msg('assistant', 'One email from Dana needs a reply. I drafted one for you.', 61 * min),
  row({ type: 'card', card: 'approval', status: 'pending', approvalId: 'a1', digest: 'd', title: 'New email', detail: 'Hi Dana,\n\n2 PM works on our side. Review moved, invite updated.\n\nAlex', actionLabel: 'Send email' }, 61 * min),
  msg('user', 'Looks good, send it.', 60 * min),
  msg('assistant', 'Done', 60 * min),
  row({ type: 'message', role: 'user', text: 'Howard, the Chase link needs a new sign-in. Can you check the connector before tonight’s sync?', from: { kind: 'bot', id: 'leonard', name: 'Leonard' } }, 30 * min),
  msg('assistant', 'On it. I will check the connector and tell you when it is back.', 29 * min),
  // Steering (server steer-mode.ts): messages sent while the bot was working.
  msg('user', 'Find me a flight to Denver next Friday', 3 * min),
  row({ type: 'message', role: 'user', text: 'Nonstop only, and morning if possible', steer: 'read' }, 2 * min),
  row({ type: 'message', role: 'user', text: 'Under $300 if you can', steer: 'pending' }, 1 * min),
];
// Browser cards (?screen=browsercards): a secure input card, a purchase card and a needs-you card.
const BROWSER_ROWS: Row[] = [
  msg('user', 'Log in to the water company and pay this month’s bill.', 9 * min),
  row({ type: 'card', card: 'approval', status: 'allowed', approvalId: 'b0', digest: 'd', tool: 'secure_input', title: 'Leonard needs your password for my.citywater.example', answeredBy: 'Alex', answeredVia: 'phone app',
    secret: { kind: 'password', kindLabel: 'Password', origin: 'https://my.citywater.example', site: 'my.citywater.example', fieldLabel: 'Password', why: 'Pay the water bill', masked: true, numeric: false, result: { ok: true, detail: 'Filled', at: now } } }, 8 * min),
  row({ type: 'card', card: 'approval', status: 'pending', approvalId: 'bv', digest: 'd', tool: 'saved_login', title: 'Leonard wants to sign in to my.citywater.example with Alex’s saved login',
    vault: { origin: 'https://my.citywater.example', site: 'my.citywater.example', login: 'login_1', savedSite: 'citywater.example', label: 'Water bill', userHint: 'al•••@example.com', fields: ['username', 'password'], fieldLabels: ['Email', 'Password'], owner: 'Alex', forScoped: false, connectorFirst: false, why: 'Pay the water bill' } }, 8.5 * min),
  row({ type: 'card', card: 'approval', status: 'pending', approvalId: 'bs', digest: 'd', tool: 'secure_input', title: 'Leonard needs your password for my.citywater.example',
    secret: { kind: 'password', kindLabel: 'Password', origin: 'https://my.citywater.example', site: 'my.citywater.example', fieldLabel: 'Password', why: 'Pay the water bill', masked: true, numeric: false, canSave: true } }, 8.2 * min),
  row({ type: 'card', card: 'approval', status: 'pending', approvalId: 'b1', digest: 'd', tool: 'secure_input', title: 'Leonard needs your one-time code for my.citywater.example',
    secret: { kind: 'one_time_code', kindLabel: 'One-time code', origin: 'https://my.citywater.example', site: 'my.citywater.example', fieldLabel: 'Enter the 6-digit code we texted you', why: '', masked: true, numeric: true } }, 6 * min),
  row({ type: 'card', card: 'approval', status: 'pending', approvalId: 'b2', digest: 'd', tool: 'purchase', title: 'Leonard wants to pay $48.00 on my.citywater.example',
    purchase: { page: { origin: 'https://my.citywater.example', site: 'City Water', title: 'Review payment', url: '', total: { amount: '48.00', currency: 'USD', text: '$48.00' }, card: { brand: 'Visa', last4: '4242' }, items: ['Water and sewer, November'], shipping: '', shipTo: '', recurring: '', controls: ['Pay now'], processors: [] },
      botSays: { amount: '48.00', currency: 'USD', merchant: 'City Water', items: ['November bill'], paymentMethod: 'Visa 4242', recurring: false, why: 'Monthly water bill' }, warnings: [] } }, 3 * min),
  row({ type: 'card', card: 'approval', status: 'pending', approvalId: 'b3', digest: 'd', tool: 'screen_help', title: 'Leonard needs you to solve a CAPTCHA on shop.example', screenHelp: { reason: 'captcha', site: 'shop.example', note: 'Tick the box and pick the pictures with buses.' } }, 1 * min),
];
// Stand-in pictures for look cards: soft circles in a few colours.
const TINTS = ['#F6C1A6', '#A9D3F5', '#C7E8B5', '#E3C6F5', '#F9E3A1', '#B8E6E0', '#F5B8C8', '#D7D2F7'];
const pic = (i: number) => `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#F4F1EC"/><circle cx="50" cy="56" r="30" fill="${TINTS[i % TINTS.length]}"/><circle cx="40" cy="50" r="4" fill="#333"/><circle cx="60" cy="50" r="4" fill="#333"/><path d="M40 64 Q50 72 60 64" stroke="#333" stroke-width="3" fill="none" stroke-linecap="round"/></svg>`)}`;
const LOOK_ROWS: Row[] = [
  msg('user', 'Can you put on some sunglasses?', 12 * min),
  row({ type: 'card', card: 'look', intent: 'tweak', description: 'add round black sunglasses', count: 6, candidates: ['0', '1', '2', '3', '4', '5'], status: 'pending' }, 11 * min),
  row({ type: 'card', card: 'look-reveal', candidateId: '2', suggestions: ['Add a hat', 'Make me a plush toy', 'Try a different style'] }, 10 * min),
  msg('user', 'Now try a whole new character, a fox.', 2 * min),
  row({ type: 'card', card: 'look', intent: 'new', description: 'a cheerful fox in a green scarf', style: 'plush', count: 4, candidates: [], status: 'making' }, 1 * min),
];
const tool = (label: string, args: any, status: string, ago: number) => row({ type: 'tool-call', name: 'terminal', label, args, status }, ago);
const WORK_ROWS: Row[] = [
  msg('user', 'Can you check why the nightly backup was slow?', 3 * min),
  tool('Ran a command', { command: 'journalctl -u backup --since yesterday' }, 'done', 2.8 * min),
  tool('Read a file', { path: '/var/log/backup/summary.txt' }, 'done', 2.5 * min),
  msg('assistant', 'The upload step took 40 minutes. Checking the network next.', 2 * min),
  tool('Ran a command', { command: 'speedtest --simple' }, 'done', 1.5 * min),
  tool('Searched the web', { query: 'rclone slow upload b2 chunk size' }, 'running', 0.3 * min),
];
const PLUGIN_TOOLS = [{ name: 'forecast', description: 'Forecast for a city', writes: false }, { name: 'save_city', description: 'Remember a favourite city', writes: true }];
const PLUGIN_ROWS: Row[] = [
  msg('user', 'Please make me a plugin: look up the weather for a city.\n\nStart by showing me a plan card (propose_plugin) with its tools and the sites it needs. If something is unclear, ask me first. Nothing gets built until I press Build, and I review the code before anything is installed.', 9 * min),
  row({ type: 'card', card: 'plugin-plan', draftId: 'pdr_1', title: 'Weather', purpose: 'Look up the forecast for a city.', tools: PLUGIN_TOOLS, network: ['api.weather.gov'], status: 'building' }, 8 * min),
  row({ type: 'card', card: 'plugin-review', draftId: 'pdr_1', title: 'Weather', digest: '29d2ab1e4051e679aa', checks: [
    { name: 'The package', ok: true, detail: 'Version 1.0.0, start file index.mjs, no install scripts, no dependencies.' },
    { name: 'Network', ok: true, detail: 'Only api.weather.gov.' }, { name: 'Secrets', ok: true, detail: 'None found.' },
    { name: 'Its tools', ok: true, detail: 'Started in the sandbox and listed forecast, save_city.' }, { name: 'Its tests', ok: true, detail: 'test.mjs passed.' },
  ], notes: ['It uses the network.'], tools: PLUGIN_TOOLS, network: ['api.weather.gov'], files: ['package.json', 'index.mjs', 'test.mjs'], status: 'pending' }, 2 * min),
  row({ type: 'card', card: 'plugin', pluginId: 'weather', pluginName: 'Weather', view: { title: 'Austin, TX', subtitle: 'Next 3 days', blocks: [
    { kind: 'fields', items: [{ label: 'Today', value: 'Sunny, 74°F' }, { label: 'Tomorrow', value: 'Rain, 61°F' }] }, { kind: 'badge', text: 'Live', tone: 'good' },
  ] } }, 1 * min),
];
const DEMO_FILES = [
  { path: 'Trip plan.docx', name: 'Trip plan.docx', size: 5120, modifiedAt: now - 3 * min, kind: 'office' },
  { path: 'Trip deck.pptx', name: 'Trip deck.pptx', size: 9830, modifiedAt: now - 3 * min, kind: 'office' },
  { path: 'budget.xlsx', name: 'budget.xlsx', size: 5632, modifiedAt: now - 3 * min, kind: 'sheet' },
  { path: 'notes/packing.md', name: 'packing.md', size: 115, modifiedAt: now - 2 * min, kind: 'markdown' },
];
// An answer view (server/src/views.ts) under a reply, as Leonard would send it.
const VIEW_BODY = {
  type: 'card', card: 'view', title: 'Phone plans for two lines', text: '**Phone plans for two lines**\n\n- **Cheapest:** $30/mo (Mint, 2 lines)\n- **You pay now:** $140/mo\n- **Yearly saving:** $1,320',
  blocks: [
    { id: 'v1', type: 'stats', items: [{ label: 'Cheapest', value: '$30/mo', tone: 'good', note: 'Mint, 2 lines' }, { label: 'You pay now', value: '$140/mo' }, { label: 'Yearly saving', value: '$1,320', tone: 'good' }] },
    { id: 'plans', type: 'table', columns: ['Plan', 'Per month', 'Data'], rows: [['Mint', '30', '15 GB'], ['Visible', '50', 'Unlimited'], ['Verizon (now)', '140', 'Unlimited']] },
    { id: 'v3', type: 'chart', chart: 'bar', title: 'Monthly cost', from: 'plans' },
    { id: 'v4', type: 'choice', question: 'Which should I set up?', options: ['Mint', 'Visible', 'Keep Verizon'], multi: false, picked: [] },
    { id: 'v5', type: 'checklist', title: 'Before switching', items: [{ id: 'a', text: 'Check coverage at home', done: true }, { id: 'b', text: 'Unlock both phones', done: false }] },
    { id: 'v6', type: 'button', label: 'Compare 3 more carriers', message: 'Compare three more carriers' },
  ],
};
const A2UI_ROWS: Row[] = A2UI_DEMO.flatMap((d, i) => [
  row({ type: 'message', role: 'user', text: d.ask }, (6 - i * 3) * min),
  row({ type: 'message', role: 'assistant', text: d.say }, (5 - i * 3) * min),
  row(d.body, (5 - i * 3) * min),
]);
const VIEW_ROWS: Row[] = [
  row({ type: 'message', role: 'user', text: 'Can we cut the phone bill?' }, 3 * min),
  row({ type: 'message', role: 'assistant', text: 'Yes. Mint would save about **$110 a month** on your two lines, and coverage at home looks fine.' }, 2 * min),
  row(VIEW_BODY, 2 * min),
  row({ type: 'message', role: 'assistant', text: 'Briefing: November is over budget in two categories.\n\n**Over budget:**\n\n| Category | Over by |\n|---|---|\n| Gifts (Christmas) | $280.16 |\n| Groceries | $173.92 |\n| Weekend Eating Out | $112.37 |\n\n**Wider table:**\n\n| Category | Budget | Spent | Left |\n|---|---:|---:|---:|\n| Gas | $100 | $85.89 | $14.11 |\n| PikePass | $40 | $0 | $40.00 |\n\nReply "approve all" or tell me which numbers to change.' }, 90_000),
  row({ type: 'message', role: 'user', text: 'What would refinancing the car save?' }, 1 * min),
  row({ type: 'card', card: 'view', viewId: 'v_calc', updatedAt: now - min, title: 'Car loan refinance', text: 'Car loan refinance\n- Balance: $18,000\n- Rate: 6.5%\n- Monthly payment: $428.39', blocks: [
    { id: 'c1', type: 'calc', title: 'Try your numbers', inputs: [
      { id: 'balance', label: 'Balance', kind: 'slider', value: 18000, min: 1000, max: 40000, step: 500, prefix: '$' },
      { id: 'rate', label: 'Rate', kind: 'slider', value: 6.5, min: 2, max: 12, step: 0.25, unit: '%' },
      { id: 'months', label: 'Term', kind: 'choice', value: 48, options: [{ label: '36 months', value: 36 }, { label: '48 months', value: 48 }, { label: '60 months', value: 60 }] },
      { id: 'gap', label: 'Keep GAP insurance ($12/mo)', kind: 'toggle', value: 1 },
    ], outputs: [
      { id: 'pay', label: 'Monthly payment', formula: 'balance * (rate / 1200) / (1 - (1 + rate / 1200) ^ -months) + gap * 12', format: 'money', big: true },
      { id: 'total', label: 'Total paid', formula: 'pay * months', format: 'money' },
      { id: 'interest', label: 'Interest', formula: 'total - balance - gap * 12 * months', format: 'money' },
    ], values: {} },
  ] }, 1 * min),
];
const ROBIN_BOARD_ROWS: Row[] = [
  msg('user', 'Can you do the Thanksgiving pickup order?', 30 * min),
  msg('assistant', 'Yes! I am filling the cart now and will tick things off as I go.', 29 * min),
  row({ type: 'card', card: 'view', viewId: 'vw_p', updatedAt: now - min, pin: { on: true, by: 'auto', at: now - 29 * min }, title: 'Thanksgiving groceries', text: 'Groceries', blocks: [
    { id: 'p', type: 'progress', label: 'Pickup order', value: 14, max: 20, note: '14 of 20 items', live: true },
    { id: 'k', type: 'checklist', items: [{ id: 'a', text: '18 lb turkey', done: true }, { id: 'b', text: 'Pie crusts', done: false }] } ] }, 28 * min),
  msg('user', 'Is the turkey the 18 lb one?', 12 * min),
  msg('assistant', 'Yes, the 18 lb Butterball. Ready Wednesday after 3 PM.', 11 * min),
  msg('user', 'Perfect, thank you!', 6 * min),
  msg('assistant', 'You are welcome. Pie crusts are next, then the whipping cream.', 5 * min),
];
// Howard's systemd board: a long title and a long step, live or stopped when the reply ended.
const longBoardRows = (stopped: boolean): Row[] => BOARD_ROWS.map((r) => ((r.body as any).viewId !== 'vw_b' ? r : { ...r, body: { ...(r.body as any), updatedAt: now - 4 * min,
  title: 'Systemd timer migration for the Host1 GBrain and Honcho nightly backups (with restore check)', blocks: [
    stopped
      ? { id: 'p', type: 'progress', label: 'Timer migration', value: 1, max: 4, note: 'Stopped: the reply ended before it finished (last step: Dependencies installed; timer-data tests running against the staging copy)', stopped: { at: now - 4 * min, reason: 'the reply ended before it finished', step: 'Dependencies installed; timer-data tests running against the staging copy' } }
      : { id: 'p', type: 'progress', label: 'Timer migration', value: 1, max: 4, note: 'Step 2 of 4: writing the timer-data unit file and checking it against the staging copy of the GBrain export', live: true },
    { id: 'k', type: 'checklist', items: [{ id: 'a', text: 'Install dependencies', done: true }, { id: 'b', text: 'Write timer and service units', done: false }, { id: 'c', text: 'Run a test backup and restore', done: false }] },
  ] } }));

const BOARD_ROWS: Row[] = [
  msg('user', 'Take over that rebuild kit. It should cover the full server cluster.', 40 * min),
  msg('assistant', 'On it. I will track coverage for every machine in one board below.', 39 * min),
  row({ type: 'card', card: 'view', viewId: 'vw_b', updatedAt: now - 2 * min, pin: { on: true, by: 'auto', at: now - 38 * min }, title: 'Cluster rebuild coverage', text: 'Cluster rebuild coverage', blocks: [
    { id: 'p', type: 'progress', label: 'Inventory and recovery assessment', value: 6, max: 10, note: 'Step 6 of 10 · Host1 backup coverage', live: true },
    { id: 'k', type: 'checklist', items: [{ id: 'a', text: 'Inventory every machine', done: true }, { id: 'b', text: 'Host2 backup restores', done: true }, { id: 'c', text: 'Host1 GBrain + Honcho', done: false }] },
  ] }, 38 * min),
  msg('assistant', 'The weekly kit covers the media server, not the full cluster. I started a cluster recovery tracker.', 35 * min),
  msg('user', 'Yes, proceed.', 30 * min),
  msg('assistant', 'The privileged inventory is complete. Main gaps: off-site coverage for Host1, verified backups on Host3 to 5, and a restore drill.', 25 * min),
  msg('user', 'Implement it.', 20 * min),
  msg('assistant', 'Saved the recovery plan. May I make the scoped backup and schedule changes?', 15 * min),
  msg('user', 'Approve privileged changes.', 10 * min),
  msg('assistant', "I'll start with Host1's GBrain and Honcho gap and test the new backup before enabling its weekly schedule.", 5 * min),
];
// Choice buttons (server/src/choices.ts) under Leonard's questions: one answered, one waiting, one with Other.
const quickBody = (question: string, options: string[], extra: Record<string, unknown> = {}) => ({
  type: 'card', card: 'view', title: '', quick: true, text: question,
  blocks: [{ id: 'c', type: 'choice', question, options, multi: false, picked: [], ...extra }],
});
const CHOICE_ROWS: Row[] = [
  row({ type: 'message', role: 'user', text: 'How are groceries looking?' }, 6 * min),
  row({ type: 'message', role: 'assistant', text: 'The PayPal charge shows up twice in Actual. Should I delete the $813.87 PayPal entry and add it again once it posts?' }, 5 * min),
  row(quickBody('Should I delete the $813.87 PayPal entry and add it again once it posts?', ['Yes', 'No'], { picked: [0], sentAt: now - 4 * min }), 5 * min),
  row({ type: 'message', role: 'user', text: 'Yes' }, 4 * min),
  row({ type: 'message', role: 'assistant', text: 'Done. Groceries are at **$940** with a week to go. Hold at $1,000 or budget $1,200?' }, 2 * min),
  row(quickBody('Hold at $1,000 or budget $1,200?', ['Hold at $1,000', 'Budget $1,200']), 2 * min),
  row({ type: 'message', role: 'assistant', text: 'And which day works for the Costco run?' }, 1 * min),
  row(quickBody('Which day works for the Costco run?', ['Saturday', 'Sunday'], { other: true }), 1 * min),
];
const FILE_ROWS: Row[] = [
  msg('user', 'Write up the trip plan as a Word doc, a short deck and a budget sheet.', 5 * min),
  msg('assistant', 'Done. I made the plan, a short deck and the budget.', 3 * min),
  row({ type: 'card', card: 'files', files: DEMO_FILES }, 3 * min),
];
const slide = (title: string, lines: string[]) => `data:image/svg+xml;utf8,${(`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="1600" height="900" fill="#fff"/><text x="90" y="130" font-family="sans-serif" font-size="64" font-weight="700" fill="#1f2328">${title}</text>${lines.map((l, i) => `<text x="140" y="${260 + i * 70}" font-family="sans-serif" font-size="40" fill="#1f2328">- ${l}</text>`).join('')}</svg>`)}`;
const blk = (id: string, type: string, extra: Record<string, unknown>) => ({ id, type, rev: 1, by: 'Leonard', byKind: 'bot', at: now, ...extra });
const DEMO_PAGE = { cleftPage: 1, id: 'pg_demo', title: 'Weekend trip plan', version: 6, updatedAt: now - 2 * min, blocks: [
  blk('b1', 'text', { md: "Here's a first pass at the trip. Tick things off as you go and edit the costs; I'll keep the totals and chart up to date." }),
  blk('b2', 'heading', { text: 'Packing', level: 2 }),
  blk('b3', 'checklist', { items: [{ id: 'i1', text: 'Passports', done: true }, { id: 'i2', text: 'Chargers', done: false }, { id: 'i3', text: 'Hiking boots', done: false }] }),
  blk('b4', 'table', { title: 'Costs', columns: ['Item', 'Cost', 'Tax'], rows: [['Hotel', '300', '30'], ['Car', '120', '12'], ['Food', '200', '0']], total: true }),
  blk('b5', 'callout', { tone: 'warn', md: 'Book the hotel by **Friday** to keep this rate.', alt: { by: 'Alex', byKind: 'person', at: now, fields: { md: 'Book by Thursday noon.' } } }),
  blk('b6', 'chart', { chart: 'bar', title: 'Costs', from: 'b4', labels: [], series: [] }),
  blk('b7', 'choice', { question: 'Where should we go?', options: ['Beach', 'Mountains', 'City'], picked: [1], multi: false }),
  blk('b8', 'form', { title: 'Details for booking', submitLabel: 'Send to Leonard', fields: [{ id: 'who', label: 'Who is going', kind: 'text', value: 'Alex and Sam' }, { id: 'when', label: 'Leave on', kind: 'date', value: '' }] }),
  blk('b9', 'button', { label: 'Re-check hotel prices', message: 'Re-check hotel prices' }),
  blk('b10', 'calc', { title: 'Car loan', inputs: [{ id: 'amount', label: 'Amount', kind: 'slider', min: 0, max: 50000, step: 500, value: 18000, prefix: '$' }, { id: 'months', label: 'Months', kind: 'number', value: 48 }], outputs: [{ id: 'monthly', label: 'Monthly', formula: 'amount / months', format: 'money', big: true }] }),
] };
const DEMO_SHELF = [
  { path: 'Car loan.page.json', id: 'pg_a', title: 'Car loan', updatedAt: now - 3 * min, version: 4, blocks: 2, kind: 'calculator', snippet: 'Monthly payment for the new car', pinned: true, origin: { chatId: 'leonard', chatTitle: 'Main chat', kind: 'view', seq: 12 }, sendTo: 'leonard' },
  { path: 'Weekend trip plan.page.json', id: 'pg_demo', title: 'Weekend trip plan', updatedAt: now - 2 * 60 * min, version: 6, blocks: 9, kind: 'chart', snippet: "Here's a first pass at the trip · Packing · Passports, Chargers", pinned: false, origin: { chatId: 'side1', chatTitle: 'Trip ideas', kind: 'bot' }, sendTo: 'side1' },
  { path: 'Grocery list.page.json', id: 'pg_b', title: 'Grocery list', updatedAt: now - 26 * 60 * min, version: 2, blocks: 1, kind: 'checklist', snippet: 'Milk, eggs, bread', pinned: false, origin: null, sendTo: 'leonard' },
];
// A message with a picture and a file (?screen=attach), and one still on its way (?screen=sending).
const PIC = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#9ec5e8"/><circle cx="140" cy="60" r="26" fill="#fff3c4"/><path d="M0 160l60-70 50 50 30-30 60 60v30H0z" fill="#3f7d58"/></svg>');
const ATTACH_ROWS: Row[] = [
  msg('assistant', 'Send me the receipt and I will add it to the trip budget.', 9 * min),
  row({ type: 'message', role: 'user', text: 'Here it is, with the booking.', attachments: [
    { path: 'uploads/2026-11-24/Receipt.jpg', name: 'Receipt.jpg', size: 284_000, modifiedAt: now, kind: 'image' },
    { path: 'uploads/2026-11-24/Booking.pdf', name: 'Booking.pdf', size: 91_000, modifiedAt: now, kind: 'pdf' },
  ] }, 8 * min),
  msg('assistant', 'Got both. The hotel was **$480** for two nights; I added it under Travel.', 7 * min),
];
const CONVERSATIONS = [
  { generation: 3, current: true, title: 'Here it is, with the booking.', messages: 3, startedAt: now - 9 * min, lastAt: now - 7 * min },
  { generation: 2, current: false, title: 'What do we still need for Saturday?', messages: 14, startedAt: now - 26 * 60 * min, lastAt: now - 25 * 60 * min },
  { generation: 1, current: false, title: 'Plan the week’s dinners around the farm box', messages: 31, startedAt: now - 6 * 24 * 60 * min, lastAt: now - 5 * 24 * 60 * min },
];
const HITS = [
  { chatId: 'leonard', botId: 'leonard', sideTitle: null, generation: 4, seq: 12, current: true, who: 'bot', from: null, snippet: 'The hotel was $480 for two nights; I added it under Travel.', at: 4, len: 5, createdAt: now - 7 * min },
  { chatId: 'robin', botId: 'robin', sideTitle: null, generation: 2, seq: 5, current: false, who: 'you', from: null, snippet: 'Can you find a hotel near the lake for the second weekend of June?', at: 15, len: 5, createdAt: now - 12 * 24 * 60 * min },
  { chatId: 'side_1', botId: 'howard', sideTitle: 'Trip research', generation: 1, seq: 3, current: true, who: 'bot', from: null, snippet: 'Three hotel options are within the budget; the cheapest is the Lakeside Inn.', at: 6, len: 5, createdAt: now - 3 * 24 * 60 * min },
];
const TEACH_STEPS = [
  { kind: 'page', name: 'Page', role: 'page', origin: 'https://shop.example.com', url: 'https://shop.example.com/', text: 'Pet Shop' },
  { kind: 'type', name: 'Search', role: 'textbox', origin: 'https://shop.example.com', text: 'dog food' },
  { kind: 'press', name: 'Search', role: 'textbox', origin: 'https://shop.example.com' },
  { kind: 'click', name: 'Sign in', role: 'link', origin: 'https://shop.example.com' },
  { kind: 'type', name: '[sensitive field]', role: 'textbox', origin: 'https://shop.example.com', sensitive: true },
  { kind: 'click', name: 'Add to cart', role: 'button', origin: 'https://shop.example.com' },
].map((s, i) => ({ at: now - (10 - i) * 20_000, ...s }));
const TEACH_DEMO = {
  id: 'tch_demo', botId: 'leonard', status: 'ready', steps: TEACH_STEPS, note: '', model: 'demo', error: null, skillName: null, startedAt: now - 300_000, stoppedAt: now - 60_000,
  lines: ['Open https://shop.example.com/ (Pet Shop)', 'Type “dog food” into “Search”', 'Press Enter in “Search”', 'Click the “Sign in” link', 'Fill a sensitive field on shop.example.com (its value was not recorded)', 'Click the “Add to cart” button'],
  draft: { name: 'order-dog-food', description: 'Use when the person asks to reorder dog food from the pet shop.', body: '## Steps\n\n1. Open the pet shop.\n2. Search for the food the person names (ask if unsure).\n3. Sign in: call ask_secure_input for the password.\n4. Add it to the cart.\n5. Call request_purchase_approval before paying.' },
};
const fake = {
  search: async () => ({ q: 'hotel', hits: HITS }),
  conversations: async () => ({ conversations: CONVERSATIONS }),
  conversationRows: async () => ({ generation: 2, rows: ROWS }),
  openConversation: async () => ({ ok: true, generation: 2 }),
  exportChat: async () => ({ name: 'Conversation.md', markdown: '# Conversation' }),
  markUnread: async () => ({ ok: true }),
  version: async () => ({ version: '0.9.0', commit: 'abc1234def', startedAt: now }),
  notifyPrefs: async () => ({ prefs: { channels: { messages: true, approvals: true, jobs: true }, muted: { scout: 0 }, dndUntil: 0, quiet: { on: false, start: '22:00', end: '07:00', tz: 'UTC', approvalsRing: true }, preview: true } }),
  send: () => new Promise(() => {}),
  listSummary: async () => ({ prefs: { on: true, provider: null, model: null }, options: { ready: true, auto: { provider: 'openai-codex', model: 'gpt-5.4-mini' }, providers: [{ id: 'openai-codex', name: 'ChatGPT', models: ['gpt-5.4-mini', 'gpt-5.5'] }] }, lastError: null }),
  setListSummary: async (p: any) => ({ prefs: { on: true, provider: null, model: null, ...p } }),
  sessions: async () => ({ sessions: [
    { id: 's1', device: 'YBots for Android, Pixel 9', who: 'Alex', kind: 'person', current: true, createdAt: Date.now() - 9 * 86400_000, lastSeenAt: Date.now(), expiresAt: Date.now() + 30 * 86400_000 },
    { id: 's2', device: 'YBots for Windows, STUDY-PC', who: 'Alex', kind: 'person', current: false, createdAt: Date.now() - 20 * 86400_000, lastSeenAt: Date.now() - 3 * 3600_000, expiresAt: Date.now() + 30 * 86400_000 },
    { id: 's3', device: 'Chrome on Mac', who: 'Alex', kind: 'person', current: false, createdAt: Date.now() - 40 * 86400_000, lastSeenAt: Date.now() - 6 * 86400_000, expiresAt: Date.now() + 30 * 86400_000 },
    { id: 's4', device: null, who: 'Claude: backups', kind: 'script', current: false, createdAt: Date.now() - 2 * 86400_000, lastSeenAt: null, expiresAt: Date.now() + 86400_000 },
  ] }),
  status: async () => ({ at: Date.now(), server: { version: '0.9.0', commit: 'abc1234def', startedAt: Date.now() - 5 * 3600_000, uptimeSec: 5 * 3600 + 720, node: 'v22', host: 'home-server', memoryMb: 212, load: 0.4, cpus: 8 },
    db: { path: 'data/app.db', bytes: 48_000_000, walBytes: 0, integrity: 'ok', integrityAt: Date.now() - 3600_000, snapshots: [{ name: 'app-2026-11-24.db', bytes: 47_500_000, at: Date.now() - 9 * 3600_000 }, { name: 'app-2026-11-23.db', bytes: 47_000_000, at: Date.now() - 33 * 3600_000 }], snapshotsKeep: 7, lastSnapshotError: null, lastMaintenanceAt: Date.now() - 9 * 3600_000, lastMaintenance: 'freed 2 MB' },
    disk: { freeBytes: 182 * 1_073_741_824, totalBytes: 500 * 1_073_741_824 },
    bots: [{ id: 'leonard', name: 'Leonard', engine: 'hermes', state: 'ready', error: null, busy: true, awaiting: false, model: 'gpt-5.5', provider: 'openai' }, { id: 'howard', name: 'Howard', engine: 'hermes', state: 'ready', error: null, busy: false, awaiting: true, model: 'gpt-5.5', provider: 'openai' }, { id: 'robin', name: 'Robin', engine: 'hermes', state: 'starting', error: null, busy: false, awaiting: false, model: null, provider: null }],
    scheduler: { on: true, routines: 6, nextRunAt: Date.now() + 1800_000, nextName: 'Morning brief' }, apps: { listening: 3 }, backup: { tag: 'weekly', at: Date.now() - 2 * 86400_000, ok: true },
    requests: { total: 18234, errors: 3, slow: 11, lastErrorAt: null, slowest: [] }, problems: [{ at: Date.now() - 2 * 3600_000, level: 'warn', text: 'Robin took 40 seconds to start.', count: 2 }], problemTotals: { warn: 2, error: 0 },
    checks: [{ id: 'db', label: 'Database', state: 'ok', detail: '46 MB, checked an hour ago with no damage found.' }, { id: 'disk', label: 'Disk space', state: 'ok', detail: '182 GB free of 500 GB.' }, { id: 'bots', label: 'Bots', state: 'warn', detail: '2 of 3 ready; Robin is starting.' }, { id: 'routines', label: 'Routines', state: 'ok', detail: '6 routines; next is Morning brief in 30 min.' }, { id: 'backup', label: 'Backup', state: 'ok', detail: 'Last weekly backup finished 2 days ago.' }] }),
  vaultLogins: async () => ({ bots: [{ id: 'leonard', name: 'Leonard' }, { id: 'howard', name: 'Howard' }], logins: [
    { id: 'login_1', site: 'citywater.example', label: 'Water bill', userHint: 'al•••@example.com', hasUsername: true, hasPassword: true, bots: null, connectorFirst: false, createdAt: now - 9 * 86400_000, updatedAt: now - 9 * 86400_000, lastUsedAt: now - 8 * min, uses: 4 },
    { id: 'login_2', site: 'library.example.org', label: '', userHint: '12•••', hasUsername: true, hasPassword: true, bots: ['leonard'], connectorFirst: false, createdAt: now - 30 * 86400_000, updatedAt: now - 30 * 86400_000, lastUsedAt: null, uses: 0 },
    { id: 'login_3', site: 'firstbank.example', label: 'Checking', userHint: 'al•••', hasUsername: true, hasPassword: true, bots: ['leonard'], connectorFirst: true, createdAt: now - 3 * 86400_000, updatedAt: now - 3 * 86400_000, lastUsedAt: now - 2 * 86400_000, uses: 1 },
  ] }),
  activity: async (f: any) => {
    const m = 60_000, t = Date.now();
    const by = (kind: string, name: string | null, text: string, unwatched = false) => ({ kind, id: null, name, text, phrase: kind === 'routine' ? `started by routine "${name}"` : kind === 'handoff' ? `asked by ${name}` : kind === 'goal' ? 'started by scheduled check-in' : 'started by a person', unwatched });
    const all = [
      { id: 9, at: t - 3 * m, botId: 'howard', botName: 'Howard', forName: 'Alex', by: by('routine', 'Nightly backup check', 'Routine · Nightly backup check', true), source: 'card', tool: 'hermes__terminal', title: 'Hermes: run a terminal command', outcome: 'refused', how: 'Asked on its card, nobody answered in time', detail: 'sudo systemctl restart backup.timer', looks: false },
      { id: 8, at: t - 11 * m, botId: 'leonard', botName: 'Leonard', forName: 'Alex', by: by('handoff', 'Robin', 'Asked by Robin', true), source: 'handoff', tool: 'send_to_bot', title: 'Message to Sheldon refused', outcome: 'refused', how: 'Slack link', detail: 'Messages to Sheldon are paused.', looks: false },
      { id: 7, at: t - 26 * m, botId: 'leonard', botName: 'Leonard', forName: 'Alex', by: by('person', null, 'A person'), source: 'card', tool: 'gmail__create_draft', title: 'Gmail: create a draft', outcome: 'allowed', how: 'Asked on its card, answered by Alex (phone app)', detail: null, looks: false },
      { id: 6, at: t - 48 * m, botId: 'robin', botName: 'Robin', forName: 'Sam', by: by('goal', 'Scheduled check-in', 'Scheduled check-in', true), source: 'tool', tool: 'actual__transactions_filter', title: 'Actual: find transactions', outcome: 'failed', how: 'Always allow', detail: 'The budget server did not answer.', looks: true },
      { id: 5, at: t - 70 * m, botId: 'howard', botName: 'Howard', forName: 'Alex', by: by('person', null, 'A person'), source: 'gate', tool: 'hermes__write_file', title: 'Hermes: write a file', outcome: 'allowed', how: 'Always allow', detail: '/srv/notes/todo.md', looks: false },
      { id: 4, at: t - 26 * 60 * m, botId: 'leonard', botName: 'Leonard', forName: 'Alex', by: by('person', null, 'A person'), source: 'export', tool: 'activity_export', title: 'Exported 212 activity rows', outcome: 'allowed', how: 'A person, web', detail: 'Filter: nobody watching', looks: false },
    ];
    const rows = all.filter((r) => (!f.outcome || r.outcome === f.outcome) && (!f.by || (f.by === 'unwatched' ? r.by.unwatched : r.by.kind === f.by)) && (!f.botId || r.botId === f.botId));
    return { rows, more: false, counts: { allowed: 3, refused: 2, failed: 1, unwatched: 3 }, bots: [{ id: 'howard', name: 'Howard' }, { id: 'leonard', name: 'Leonard' }, { id: 'robin', name: 'Robin' }] };
  },
  activityExport: async () => ({ csv: 'Time (UTC),Bot\r\n', rows: 6, truncated: false, filename: 'ybots-activity.csv' }),
  usage: async (days: number) => { const byDay = Array.from({ length: days }, (_, i) => ({ day: new Date(Date.now() - (days - 1 - i) * 86400_000).toISOString().slice(0, 10), turns: Math.round(18 + 14 * Math.sin(i / 2) + (i % 5) * 3), failed: i % 6 === 0 ? 1 : 0, inputTokens: 90_000 + i * 4000, outputTokens: 11_000 + i * 300 })); const sum = (k: 'turns' | 'failed' | 'inputTokens' | 'outputTokens') => byDay.reduce((a, d) => a + d[k], 0); const totals = { turns: sum('turns'), failed: sum('failed'), inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens') };
    return { days, since: Date.now() - days * 86400_000, totals, byDay, byBot: [{ botId: 'leonard', name: 'Leonard', lastAt: Date.now() - 9 * 60_000, topModel: 'gpt-5.5', turns: Math.round(totals.turns * 0.55), failed: 1, inputTokens: 900_000, outputTokens: 120_000 }, { botId: 'howard', name: 'Howard', lastAt: Date.now() - 3 * 3600_000, topModel: 'gpt-5.5', turns: Math.round(totals.turns * 0.3), failed: 2, inputTokens: 600_000, outputTokens: 80_000 }, { botId: 'robin', name: 'Robin', lastAt: Date.now() - 30 * 3600_000, topModel: 'gpt-5.4-mini', turns: Math.round(totals.turns * 0.15), failed: 0, inputTokens: 0, outputTokens: 0 }], byModel: [{ provider: 'openai-codex', model: 'gpt-5.5', turns: Math.round(totals.turns * 0.85), failed: 3, inputTokens: 1_500_000, outputTokens: 200_000 }, { provider: 'openai-codex', model: 'gpt-5.4-mini', turns: Math.round(totals.turns * 0.15), failed: 0, inputTokens: 0, outputTokens: 0 }] }; },
  deleteConversation: async () => ({ ok: true, conversations: CONVERSATIONS.slice(0, 1) }),
  snapshotNow: async () => ({ ok: true, snapshot: { name: 'app-now.db', bytes: 47_900_000, at: Date.now() } }),
  allowRules: async () => ({ rules: [
    { id: 'r1', botId: 'leonard', botName: 'Leonard', tool: 'actual__budget_set', label: 'Change the budget', createdBy: 'Alex', createdVia: 'phone app', createdAt: Date.now() - 3 * 86400_000, uses: 4, lastUsedAt: Date.now() - 3600_000, risk: 'money' },
    { id: 'r2', botId: 'howard', botName: 'Howard', tool: 'hermes__status', label: 'Check the gateway', createdBy: 'Alex', createdVia: 'web', createdAt: Date.now() - 86400_000, uses: 0, lastUsedAt: null, risk: null },
  ], log: [{ id: 1, ruleId: 'r1', botId: 'leonard', botName: 'Leonard', tool: 'actual__budget_set', label: 'Change the budget', detail: '', at: Date.now() - 3600_000 }] }),
  policies: async () => ({ policies: [{ tool: 'GMAIL_SEND_EMAIL', mode: 'blocked' }] }),
  computerDetails: async () => ({ computer: { status: 'running', error: null, screens: [], maxScreens: 4 }, screens: [{ botId: 'leonard', screenId: 'default', lastUsedAt: Date.now() - 600_000 }, { botId: 'howard', screenId: 'screen-100', lastUsedAt: Date.now() - 7200_000 }], hibernation: { idleMinutes: 20, viewers: 0, dryRun: false } }),
  deviceLink: async () => ({ url: 'https://cleft.example.com/api/auth/link?t=demo-one-time-token-abcdefghijklmnop', appLink: 'cleftbot://sign-in?link=demo', expiresAt: Date.now() + 15 * 60_000 }),
  setLinkPaused: async () => ({ ok: true }),
  exchanges: async () => ({ error: null, exchanges: [
    { id: 2, direction: 'out', botId: 'leonard', botName: 'Leonard', roomId: null, type: 'Q', text: 'Does the lease renewal need a signature from both of you, or just Alex?', link: 'https://slack.com/x', state: 'answered', error: null, createdAt: Date.now() - 50 * 60_000, answeredAt: Date.now() - 44 * 60_000, replies: [{ text: 'Both signatures. I put a reminder on the shared calendar for Friday.', link: null, createdAt: Date.now() - 44 * 60_000 }] },
    { id: 1, direction: 'out', botId: 'howard', botName: 'Howard', roomId: null, type: 'Q', text: 'Is the 4 PM call still on?', link: null, state: 'sent', error: null, createdAt: Date.now() - 5 * 60_000, answeredAt: null, replies: [] },
    { id: 3, direction: 'in', botId: null, botName: null, roomId: null, type: 'FYI', text: 'Heads up: the court date moved to the 14th.', link: null, state: 'answered', error: null, createdAt: Date.now() - 3 * 3600_000, answeredAt: null, replies: [] },
  ] }),
  viewChange: async () => ({ ok: true }),
  pinBoard: async () => ({ ok: true }),
  viewPage: async () => ({ ok: true, path: 'Car loan refinance.page.json' }),
  page: async () => DEMO_PAGE,
  pageList: async () => ({ pages: DEMO_SHELF }),
  pageOps: async () => ({ page: DEMO_PAGE, results: [{ ok: true }] }),
  pageHistory: async () => ({ versions: [{ version: 6, by: 'Alex', byKind: 'person', at: now - 2 * min, summary: 'ticked "Passports"' }, { version: 5, by: 'Leonard', byKind: 'bot', at: now - 4 * min, summary: 'added a chart, added a choice' }] }),
  chatFiles: async () => ({ files: DEMO_FILES.map((f, i) => ({ ...f, seq: i })) }),
  files: async () => ({ status: 'ok', path: '', files: [
    { name: 'notes', size: 0, modifiedAt: now - 2 * min, isDir: true },
    ...DEMO_FILES.filter((f) => !f.path.includes('/')).map((f) => ({ name: f.name, size: f.size, modifiedAt: f.modifiedAt, isDir: false })),
  ] }),
  filePreview: async (_b: string, path: string) => {
    const f = DEMO_FILES.find((x) => x.path === path)!;
    if (f.kind === 'markdown') return { ...f, editable: true, text: '# Packing notes\n\n- Rain jacket\n- Hiking boots\n\n> Check the parkway closures first.' };
    if (f.kind === 'sheet') return { ...f, editable: false, sheets: [{ name: 'Sheet1', truncated: false, rows: [['Item', 'Cost', 'Who'], ['Hotel', '480', 'Alex'], ['Food', '300', 'Sam'], ['Gas', '90', 'Alex']] }] };
    return { ...f, editable: false, pages: 2 };
  },
  filePageUrl: (_b: string, _p: string, n: number) => (n === 1 ? slide('Asheville weekend', []) : slide('Plan', ['Friday drive', 'Saturday hike', 'Sunday Biltmore'])),
  fileRawUrl: () => pic(1),
  connectors: async () => ({ owner: true, scanHosts: 6, lastScan: { at: now - 3 * 3600_000, answered: ['build-server', 'host02'], found: 75, added: 0, gone: 0 },
    bots: BOTS.filter((b) => b.kind !== 'room').map((b) => ({ id: b.id, name: b.name })), connectors: [
    { id: 'demo', name: 'Demo CMS', machine: 'host02', transport: 'http', address: null, access: null, auth: null, reach: 'cleft', description: null, notes: null, firm: false, status: 'active', source: 'catalog', firstSeen: null, lastSeen: null, goneAt: null, apps: [{ id: 'demo', name: 'Demo CMS', status: 'ready', bots: ['Howard'] }], canAdd: false, added: false, wanted: null },
    { id: 'report-mailbox', name: 'Report mailbox', machine: 'build-server', transport: 'http', address: null, access: null, auth: null, reach: 'cleft', description: 'Where agents publish reports for you.', notes: null, firm: false, status: 'active', source: 'catalog', firstSeen: null, lastSeen: null, goneAt: null, apps: [], canAdd: true, added: false, wanted: null },
    { id: 'claude-browser', name: 'Shared browser (claude_browser)', machine: 'host01', transport: 'http', address: null, access: null, auth: null, reach: 'needs-setup', description: 'A real Chromium that keeps your sign-ins.', notes: null, firm: false, status: 'active', source: 'catalog', firstSeen: null, lastSeen: null, goneAt: null, apps: [], canAdd: false, added: false, wanted: { rank: 4, unlocks: 'A real browser with saved sign-ins.', needs: 'The Host1 key line.' } },
    { id: 'walmart-sams', name: "Walmart and Sam's Club accounts", machine: null, transport: null, address: null, access: null, auth: null, reach: 'needs-setup', description: null, notes: null, firm: false, status: 'wanted', source: 'catalog', firstSeen: null, lastSeen: null, goneAt: null, apps: [], canAdd: false, added: false, wanted: { rank: 5, unlocks: 'Carts', via: 'browser' }, browserSite: true },
    { id: 'flight-status', name: 'Flight status (FlightAware AeroAPI)', machine: null, transport: null, address: null, access: null, auth: null, reach: 'needs-setup', description: 'A flight-status feed.', notes: null, firm: false, status: 'wanted', source: 'catalog', firstSeen: null, lastSeen: null, goneAt: null, apps: [], canAdd: false, added: false, wanted: { rank: 7, unlocks: 'Alerts for delays on family flights.', needs: 'A FlightAware key.' } },
  ] }),
  googleConnector: async () => ({ configured: true, redirectUri: 'https://demo/api/connectors/google/callback' }),
  webSearch: async () => ({ service: 'Brave Search', keySet: true, extract: 'Built in', fallback: null, cacheMinutes: 60, monthStart: now - 9 * 86400_000, bots: BOTS.filter((b) => b.kind !== 'room').map((b, i) => ({ id: b.id, name: b.name, on: i !== 2, ownSetup: false, searches: 12 * (i + 1), reads: 4 * i })) }),
  adminChanges: async () => ({ changes: [] }),
  connections: async () => ({ owner: true, ready: [
    { id: 'google-alex-example-com', name: 'Google (alex@example.com)', summary: 'Gmail, Calendar and Drive for alex@example.com. Reads run on their own; changes ask first.', problem: 'Tasks isn\'t allowed yet. Press Reconnect and tick every box on Google\'s page.', needsSignIn: false, onlyBots: null, canDelete: true, reconnect: true },
  ], connections: [
    { id: 'google', name: 'Google (Alex)', kind: 'google', state: 'needs_reconnect', stateText: 'Needs reconnect', summary: 'Gmail, Calendar and Drive.', problem: 'An older Google sign-in, without Tasks. Press Reconnect to sign in again with Tasks; its Bots move to the new sign-in.', usedBy: 'Used by Leonard', bots: BOTS.filter((b) => b.kind !== 'room').map((b, i) => ({ id: b.id, name: b.name, on: i === 1 })), toolsLine: '31 tools: 20 run on their own, 11 ask first', tools: [], reconnect: { label: 'Reconnect', hint: 'Opens Google\'s page. Pick the same account and tick every box.', write: true, confirm: true }, actions: [{ id: 'turn_off', label: 'Turn off', danger: true, hint: 'Stops it for every Bot, keeping its setup.' }, { id: 'remove', label: 'Remove', danger: true, hint: 'Removes it from your server. Undo in Recent changes puts it back exactly.' }], firm: false, details: [{ label: 'Where it runs', value: 'On your server.' }, { label: 'Set up in', value: 'The server\'s connection file (apps.json)' }] },
    { id: 'actual', name: 'Actual budget', kind: 'service', state: 'connected', stateText: 'Connected', summary: 'The household budget in Actual.', problem: null, usedBy: 'Used by Leonard and Robin', bots: BOTS.filter((b) => b.kind !== 'room').map((b, i) => ({ id: b.id, name: b.name, on: i > 0 })), toolsLine: '4 tools: 1 run on their own, 3 ask first',
      tools: [{ name: 'list_cases', label: 'List budgets', rule: 'runs', chosen: false, choices: ['runs', 'asks', 'off'], note: null }, { name: 'send_note', label: 'Send note', rule: 'asks', chosen: false, choices: ['asks', 'off'], note: 'Always asks first, so it can\'t be set to run on its own.' }, { name: 'delete_case', label: 'Delete transaction', rule: 'off', chosen: true, choices: ['runs', 'asks', 'off'], note: null }],
      reconnect: { label: 'Reconnect', hint: 'Starts the connection again and lists its tools again.' }, actions: [{ id: 'turn_off', label: 'Turn off', danger: true, hint: 'Stops it for every Bot, keeping its setup. Turn it on again any time.' }, { id: 'remove', label: 'Remove', danger: true, hint: 'Removes it from your server. Undo in Recent changes puts it back exactly.' }], firm: false, details: [{ label: 'Where it runs', value: 'On your server.' }] },
    { id: 'files', name: 'Case files', kind: 'service', state: 'off', stateText: 'Off', summary: 'A service your Bots can use.', problem: 'Turned off for every Bot. Turn it on to use it again.', usedBy: 'No Bot uses it yet', bots: [], toolsLine: 'No tools listed yet', tools: [], reconnect: null, actions: [{ id: 'turn_on', label: 'Turn on', danger: false, hint: 'Starts it again for the Bots that had it.' }], firm: true, details: [] },
  ] }),
  plugins: async () => ({ owner: true, pending: [], drafts: [
    { id: 'pdr_1', botId: 'howard', botName: 'Howard', title: 'Weather', purpose: '', tools: PLUGIN_TOOLS, network: ['api.weather.gov'], status: 'checked', digest: 'x', createdAt: now, updatedAt: now },
    { id: 'pdr_2', botId: 'leonard', botName: 'Leonard', title: 'Receipt filer', purpose: '', tools: [{ name: 'file_receipt', description: '', writes: true }], network: [], status: 'planned', createdAt: now, updatedAt: now },
  ], plugins: [
    { id: 'demo', name: 'Demo CMS', origin: 'apps.json', exclusive: false, status: 'ready', tools: 3, reads: 1, blocked: 0, description: 'Posts and pages on the site.', network: [], settings: [], values: {}, history: [],
      bots: [{ id: 'howard', name: 'Howard', enabled: true, fromDefault: true }, { id: 'leonard', name: 'Leonard', enabled: false, fromDefault: false }] },
    { id: 'weather', name: 'Weather', origin: 'installed', exclusive: false, status: 'ready', tools: 2, reads: 1, blocked: 0, version: '1.0.0', digest: '29d2ab1e4051e679', network: ['api.weather.gov'],
      settings: [{ key: 'units', label: 'Units', type: 'select', options: [{ value: 'f', label: 'Fahrenheit' }, { value: 'c', label: 'Celsius' }] }, { key: 'api_key', label: 'API key', type: 'secret' }],
      values: { units: 'f', api_key: { set: true } }, history: [{ version: '1.0.0', digest: 'x', status: 'installed', installedAt: now }],
      bots: [{ id: 'howard', name: 'Howard', enabled: true, fromDefault: false }] },
  ] }),
  flipPlugin: async (pluginId: string, botId: string, enabled: boolean | null) => ({ pluginId, botId, pluginName: pluginId === 'demo' ? 'Demo CMS' : 'Weather', botName: botId === 'howard' ? 'Howard' : 'Leonard',
    before: { enabled: !enabled, fromDefault: false }, after: { enabled: !!enabled, fromDefault: enabled === null } }),
  proposePlugin: async (b: { action: string; pluginId?: string }) => ({ id: 'pch_1', action: b.action, summary: b.action === 'delete' ? 'Delete Weather' : 'Change', digest: 'x', status: 'pending', expiresAt: Date.now() + 600000,
    details: ['It is on for Howard. They lose its tools.', "Its files (one version) and saved settings are deleted from the server. This can't be undone."] }),
  pluginCode: async () => ({ draftId: 'pdr_1', title: 'Weather', status: 'checked', digest: '29d2ab1e4051e679aa', matches: true, files: [
    { path: 'package.json', size: 78, text: '{ "name": "weather-plugin", "version": "1.0.0", "type": "module", "main": "index.mjs" }' },
    { path: 'cleftbot-mcp.mjs', size: 5120, text: null, kit: true },
    { path: 'index.mjs', size: 260, text: "import { serve } from './cleftbot-mcp.mjs';\n\nserve({\n  name: 'weather',\n  tools: [{\n    name: 'forecast', description: 'Forecast', readOnly: true,\n    run: async ({ city }) => {\n      const r = await fetch(`https://api.weather.gov/points?q=${encodeURIComponent(city)}`);\n      return (await r.json()).summary;\n    },\n  }],\n});\n" },
  ] }),
  bots: async () => ({ bots: BOTS, live: [] }),
  tasks: async () => ({ tasks: [
    { id: 't1', botId: 'leonard', title: 'Match November card charges to the budget', state: 'working', note: '142 of 180 matched', updatedAt: now - 3 * min },
    { id: 't2', botId: 'howard', title: 'Restart the Hermes gateway', state: 'needs_input', note: 'Waiting for your OK on the card in my chat.', updatedAt: now - 5 * min },
    { id: 't3', botId: 'robin', title: 'Price-check groceries at three stores, including the long list of pantry staples from last week', state: 'working', note: '', updatedAt: now - 40 * min },
    { id: 't4', botId: 'leonard', title: 'Renew the car registration', state: 'done', note: 'Paid; sticker arrives by mail.', updatedAt: now - 26 * 60 * min },
  ] }),
  botTasks: async () => ({ tasks: [] }),
  server: 'https://demo', authHeader: {}, lookUrl: (_b: string, id: string) => pic(Number(id)),
  // The computer screen shows its asleep state in the preview (there is no WebView on the web).
  roomMembers: async () => ({ members: ['leonard', 'robin', 'sheldon'].map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1), label: '', avatarShape: 'blob', avatarColor: 'blue' })) }),
  setRoomMembers: async (_id: string, botIds: string[]) => ({ ok: true, members: botIds }),
  computer: async () => ({ computer: { status: 'stopped', error: null, screens: [] } }),
  // Teach a bot (?screen=teach): a recording the bot has written up, waiting for review.
  teach: async () => ({ blocked: null, recording: TEACH_DEMO }),
  ensureComputer: () => new Promise(() => {}),
  machines: async () => ({ machines: [{
    id: 'pc_demo', name: 'OFFICE-PC', online: true, lastSeenAt: now, createdAt: now - 86400_000,
    folders: [{ name: 'Cleft', path: 'C:\\Users\\alex\\Documents\\Cleft' }], commands: true, screen: true, control: true,
    bots: ['leonard', 'howard'], blockedBots: ['robin', 'sheldon'], pcBlocked: ['Robin', 'Sheldon'], version: '0.4.0',
  }] }),
  machineLog: async () => ({ log: [
    { id: 2, botId: 'leonard', botName: 'Leonard', tool: 'pc_write_file', outcome: 'done', detail: null, at: now - 5 * 60_000 },
    { id: 1, botId: 'leonard', botName: 'Leonard', tool: 'pc_run', outcome: 'declined', detail: null, at: now - 9 * 60_000 },
  ] }),
  settings: async () => ({
    memories: [
      { id: 'm1', botId: 'robin', text: 'Sam prefers grocery pickup after 4 PM on weekdays.', createdAt: now - 3 * 86400_000, source: 'chat' },
      { id: 'm2', botId: 'robin', text: 'The water bill is due on the 18th each month.', createdAt: now - 9 * 86400_000, source: 'learned' },
    ],
    skills: [{ id: 's1', botId: 'robin', name: 'Weekly meal plan', description: 'Sunday planning for the week ahead', body: '1. Check the calendar\n2. Draft five dinners', createdAt: now, updatedAt: now }],
    routines: [{ id: 'r1', botId: 'robin', name: 'Morning brief', prompt: 'Summarize today: calendar, weather, and anything due.', schedule: '0 8 * * *', timezone: 'America/Chicago', enabled: true, nextRunAt: now + 12 * 3600_000, lastRunAt: null, description: 'Every day at 8 AM' }],
    memory: { lastConsolidatedAt: null, historyChars: 42_000, compactAtChars: 120_000, lastCompaction: null },
  }),
  routines: async () => ({ routines: [{ id: 'r1', botId: 'robin', name: 'Morning brief', prompt: 'Summarize today: calendar, weather, and anything due.', schedule: '0 8 * * *', timezone: 'America/Chicago', enabled: true, nextRunAt: now + 12 * 3600_000, lastRunAt: null, description: 'Every day at 8 AM' }] }),
  voiceOptions: async () => ({
    voices: [
      ['af_heart', 'Heart', 'female', 'American English'], ['af_bella', 'Bella', 'female', 'American English'], ['af_nova', 'Nova', 'female', 'American English'],
      ['am_adam', 'Adam', 'male', 'American English'], ['am_onyx', 'Onyx', 'male', 'American English'],
      ['bf_emma', 'Emma (British)', 'female', 'British English'], ['bm_fable', 'Fable (British)', 'male', 'British English'], ['bm_george', 'George (British)', 'male', 'British English'],
    ].map(([id, name, gender, group]) => ({ id, name, gender, group })),
    defaultVoice: 'af_heart',
    languages: [{ code: 'auto', name: 'Auto-detect' }, { code: 'en', name: 'English' }],
    speeds: [0.7, 0.85, 1, 1.15, 1.3, 1.5],
  }),
  engine: async () => ({ engine: {
    botId: 'robin', profile: 'robin', status: 'ready', error: null, model: 'gpt-5.5', provider: 'openai-codex', version: '0.9.2',
    providers: [
      { id: 'openai-codex', name: 'ChatGPT', kind: 'subscription', connected: true, models: ['gpt-5.5', 'gpt-5.5-mini'] },
      { id: 'anthropic', name: 'Claude', kind: 'subscription', connected: false, models: ['claude-opus-5-5', 'claude-sonnet-5-5'] },
      { id: 'openrouter', name: 'OpenRouter', kind: 'api_key', connected: true, models: [] },
    ],
    modelMode: 'auto', modelTiers: { light: { model: 'gpt-5.5-mini', effort: 'low' }, standard: { model: 'gpt-5.5', effort: 'medium' } }, providerLock: null,
    tierPresets: { 'openai-codex': { label: 'ChatGPT', tiers: { light: { model: 'gpt-5.5-mini', effort: 'low' }, standard: { model: 'gpt-5.5', effort: 'medium' }, heavy: { model: 'gpt-5.5', effort: 'high' } } } },
    lastRoute: { at: now - 60_000, mode: 'auto', tier: 'standard', provider: 'openai-codex', model: 'gpt-5.5', reason: 'ordinary request', ok: true }, ownScreen: false,
  } }),
} as unknown as Client;
const noop = () => {};

let liveSet = false;

function SplitDemo({ bots, b, listw }: { bots: typeof BOTS; b: (typeof BOTS)[number]; listw: string | null }) {
  const { width } = useWindowDimensions();
  const [full, setFull] = useState(listw === '0');
  return (
    <SplitPane total={width} full={full} onFull={setFull} initialWidth={listw ? Number(listw) || 390 : 390}
      list={(w) => <Home api={fake} bots={bots} name="Alex" refreshing={false} onRefresh={noop} onOpen={noop} onNewBot={noop} onNewGroup={noop} onTasks={noop} onSignOut={noop} selectedId={b.id} paneWidth={w} />}
      chat={<Chat api={fake} bot={b} rows={ROWS} onBack={noop} onCall={noop} onSettings={noop} onComputer={noop} onRefresh={noop} fullScreen={full} onFullScreen={() => setFull((f) => !f)} />} />
  );
}

function Boom(): React.JSX.Element { throw new Error('Cannot read property \'title\' of undefined'); }

export default function Preview() {
  const params = new URLSearchParams(globalThis.location?.search ?? '');
  const screen = params.get('screen') ?? 'home';
  // &theme=dark draws the dark palette.
  applyScheme(params.get('theme') === 'dark' ? 'dark' : 'light');
  // ?few=1 shows a new install's three bots: the main bot pinned, the other two in the list.
  const bots = params.get('few') ? BOTS.slice(0, 3).map((x, i) => ({ ...x, pinned: i === 0 })) : BOTS;
  const b = BOTS.find((x) => x.id === 'robin')!;
  if ((screen === 'home' || screen === 'split') && !liveSet) {
    liveSet = true;
    // Home shows who is working and who is waiting on you.
    setLive([
      { botId: 'leonard', isRunning: true, activity: { kind: 'working', detail: 'Matching card charges to the budget', since: now - 60_000 }, awaiting: null, startedAt: now - 240_000, model: MODEL_SONNET },
      { botId: 'howard', isRunning: false, activity: { kind: 'waiting_for_you', since: now - 5 * min }, awaiting: { reason: 'Restart the Hermes gateway', since: now - 5 * min } },
    ] as any);
    // The Needs you board: every card and task waiting on you, across the bots.
    showNeedsYou([
      { id: 'howard:41', kind: 'approval', label: 'Approval', title: 'Restart the Hermes gateway', detail: '', botId: 'howard', chatId: 'howard', seq: 41, sideTitle: null, at: now - 5 * min },
      { id: 'robin:12', kind: 'question', label: 'Question', title: 'Chicken or fish for Sunday dinner?', detail: 'Chicken · Fish', botId: 'robin', chatId: 'robin', seq: 12, sideTitle: null, at: now - 12 * min },
      { id: 'inbox:7', kind: 'email', label: 'Email to send', title: 'To school@example.org', detail: 'Field trip form', botId: 'inbox', chatId: 'inbox', seq: 7, sideTitle: null, at: now - 40 * min },
      { id: 'task:t2', kind: 'stalled', label: 'Stalled', title: 'Move the old backups to the new drive', detail: '', botId: 'howard', chatId: 'howard', taskId: 't2', sideTitle: null, at: now - 26 * 60 * min },
    ]);
  }
  let body: React.ReactNode;
  if (screen === 'welcome') body = <Welcome onSignIn={noop} />;
  else if (screen === 'signin') body = <SignIn onBack={noop} onSignedIn={noop} />;
  else if (screen === 'chat') body = <Chat api={fake} bot={b} bots={BOTS} rows={ROWS} onBack={noop} onCall={noop} onSettings={noop} onComputer={noop} onRefresh={noop} />;
  else if (screen === 'attach') body = <Chat api={fake} bot={BOTS[1]} bots={BOTS} rows={ATTACH_ROWS} onBack={noop} onCall={noop} onSettings={noop} onComputer={noop} onRefresh={noop} onFiles={noop} onHistory={noop} onSearch={noop} />;
  else if (screen === 'sending') {
    if (!sendingSet) { sendingSet = true; setOutboxAccount('demo', fake, null); enqueue('leonard', 'And what about the car hire?', [], 999); }
    body = <Chat api={fake} bot={BOTS[1]} bots={BOTS} rows={ATTACH_ROWS} onBack={noop} onCall={noop} onSettings={noop} onComputer={noop} onRefresh={noop} />;
  }
  else if (screen === 'emptychat') body = <Chat api={fake} bot={b} bots={BOTS} rows={[]} onBack={noop} onCall={noop} onSettings={noop} onComputer={noop} onRefresh={noop} />;
  else if (screen === 'history') body = <History api={fake} bot={b} chatId={b.id} onBack={noop} onContinued={noop} />;
  else if (screen === 'historyread') body = <History api={fake} bot={b} chatId={b.id} startGeneration={2} focusSeq={ROWS[1]?.seq} onBack={noop} onContinued={noop} />;
  else if (screen === 'search') body = <Search api={fake} bots={BOTS} onBack={noop} onOpen={noop} />;
  else if (screen === 'sidechats' || screen === 'sidesheet') {
    const idle = (id: string) => ({ botId: id, isRunning: false, activity: null, awaiting: null, startedAt: null });
    const SIDES: SideChat[] = [
      { id: 'side_1', botId: b.id, title: 'Make the grocery list for this week', createdAt: now - 30 * min, lastActivityAt: now - 2 * min, lastPreview: 'Here is this week\'s list: eggs, rice, apples.', unread: 1, generation: 1, live: idle('side_1') },
      { id: 'side_2', botId: b.id, title: 'Compare the flights to Denver', createdAt: now - 90 * min, lastActivityAt: now - 40 * min, lastPreview: 'Checking three airlines now.', unread: 0, generation: 1, live: { ...idle('side_2'), isRunning: true, startedAt: now - min } as any },
    ];
    for (const c of SIDES) updateLive(c.live as any);
    const sw = <><SideChatChip chats={SIDES} openId={null} onPress={noop} /><SideChatSheet visible={screen === 'sidesheet'} onClose={noop} bot={b} chats={SIDES} openId="side_1" onPick={noop} onNew={async () => {}} onRename={async () => {}} onDelete={async () => {}} /></>;
    body = <Chat api={fake} bot={b} rows={ROWS} onBack={noop} onCall={noop} onSettings={noop} onComputer={noop} onRefresh={noop} switcher={sw} />;
  }
  else if (screen === 'groupchat') {
    // ?working=1: two members answering the group, each with its model badge.
    if (params.get('working')) updateLive({ botId: GROUP.id, isRunning: true, activity: { kind: 'working', since: now - 30_000 }, awaiting: null, startedAt: now - 30_000,
      members: [{ id: 'leonard', name: 'Leonard', state: 'working', since: now - 30_000, model: MODEL_SONNET }, { id: 'robin', name: 'Robin', state: 'queued', since: now - 10_000 }] } as any);
    body = <Chat api={fake} bot={GROUP} bots={BOTS} rows={GROUP_ROWS} onBack={noop} onCall={noop} onSettings={noop} onComputer={noop} onRefresh={noop} />;
  }
  else if (screen === 'browsercards') body = <Chat api={fake} bot={BOTS[1]} bots={BOTS} rows={BROWSER_ROWS} onBack={noop} onCall={noop} onSettings={noop} onComputer={noop} onRefresh={noop} />;
  else if (screen === 'looks') body = <Chat api={fake} bot={b} rows={LOOK_ROWS} onBack={noop} onCall={noop} onSettings={noop} onComputer={noop} onRefresh={noop} />;
  else if (screen === 'working') {
    // &short=NAME: a longer model name on the chip (e.g. '6.1 Terra' or 'GPT-5.5 mini').
    // ?fallback=1: Hermes switched to a fallback model mid-turn (the badge turns amber with ↺).
    updateLive({ botId: b.id, isRunning: true, activity: { kind: 'searching_web', detail: 'rclone slow upload', since: now - 18_000 }, startedAt: now - 190_000, caption: 'Looking into the backup', model: { ...(params.get('fallback') ? { ...MODEL_SONNET, fallback: true } : MODEL_OPUS), ...(params.get('short') ? { short: params.get('short') } : null) } } as any);
    // ?screen=working&thought=1: a long thought, short recap in the bubble; tap it to see the whole thought.
    if (params.get('thought')) updateLive({ botId: b.id, isRunning: true, awaiting: null, startedAt: now - 20_000, steps: 2, activity: { kind: 'thinking', since: now - 20_000 }, caption: 'Weighing whether read-only Actual Budget tools', captionFull: "I'm weighing whether the read-only Actual Budget tools could give me enough to build the morning briefing, or whether I need the Plaid connector for live balances. The last two tries failed, so I'll check the connection first." } as any);
    // &many=1: a longer chat, so it scrolls and the big picture can shrink to its face.
    const many = params.get('many') ? [...Array.from({ length: 12 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', `Earlier message ${i + 1}: a line or two so the chat is long enough to scroll.`, (60 - i * 4) * min)), ...WORK_ROWS] : WORK_ROWS;
    body = <Chat api={fake} bot={b} rows={many} onBack={noop} onCall={noop} onSettings={noop} onComputer={noop} onRefresh={noop} />;
  }
  else if (screen.startsWith('settings')) body = <BotSettings api={fake} bot={b} initialTab={(screen.split('-')[1] || 'general') as any} onBack={noop} onBot={noop} onDeleted={noop} onComputer={noop} />;
  else if (screen === 'newgroup') body = <NewGroup api={fake} bots={bots} onBack={noop} onCreated={noop} />;
  else if (screen === 'members') body = <BotSettings api={fake} bot={GROUP} bots={bots} initialTab="members" onBack={noop} onBot={noop} onDeleted={noop} onComputer={noop} />;
  else if (screen === 'newbot') body = <NewBot api={fake} onBack={noop} onCreated={noop} />;
  else if (screen === 'look') body = <CustomLook api={fake} bot={b} onBack={noop} onSaved={noop} />;
  else if (screen === 'computer') body = <Computer api={fake} bot={b} onBack={noop} />;
  else if (screen === 'teach') body = <TeachReview api={fake} bot={b} onBack={noop} />;
  else if (screen === 'plugins' || screen === 'connections') body = <Connections api={fake} bots={bots} onBack={noop} onOpenChat={noop} onCode={noop} startCreating={!!params.get('create')} />;
  else if (screen === 'plugincode') body = <PluginCode api={fake} draftId="pdr_1" onBack={noop} />;
  else if (screen === 'plugincards') body = <Chat api={fake} bot={BOTS[0]} rows={PLUGIN_ROWS} onBack={noop} onCall={noop} onSettings={noop} onComputer={noop} onRefresh={noop} onPluginCode={noop} />;
  else if (screen === 'filechat') body = <Chat api={fake} bot={BOTS[1]} rows={FILE_ROWS} onBack={noop} onCall={noop} onSettings={noop} onComputer={noop} onRefresh={noop} onFiles={noop} />;
  else if (screen === 'choices') body = <Chat api={fake} bot={BOTS[1]} rows={CHOICE_ROWS} onFiles={noop} onBack={noop} onCall={noop} onSettings={noop} onComputer={noop} onRefresh={noop} />;
  else if (screen === 'boardsrobin') body = <Chat api={fake} bot={BOTS[2]} bots={BOTS} rows={ROBIN_BOARD_ROWS} onFiles={noop} onBack={noop} onCall={noop} onSettings={noop} onComputer={noop} onRefresh={noop} />;
  else if (screen === 'boardsgroup') body = <Chat api={fake} bot={GROUP} bots={BOTS} rows={[...GROUP_ROWS,
    row({ type: 'card', card: 'view', viewId: 'g1', from: { id: 'robin', name: 'Robin' }, updatedAt: now - min, pin: { on: true, by: 'auto', at: now - 20 * min }, title: 'Thanksgiving groceries', text: 'x', blocks: [{ id: 'p', type: 'progress', label: 'Pickup', value: 14, max: 20, note: '14 of 20 items', live: true }] }, 6 * min),
    row({ type: 'card', card: 'view', viewId: 'g2', from: { id: 'leonard', name: 'Leonard' }, updatedAt: now - 5 * min, pin: { on: true, by: 'bot', at: now - 20 * min }, title: 'Thanksgiving budget', text: 'x', blocks: [{ id: 'p', type: 'progress', label: 'Spent of $420', value: 286, max: 420 }] }, 5 * min)]} onBack={noop} onCall={noop} onSettings={noop} onComputer={noop} onRefresh={noop} />;
  else if (screen === 'boardslong' || screen === 'boardsstopped') body = <Chat api={fake} bot={BOTS[0]} bots={BOTS} rows={longBoardRows(screen === 'boardsstopped')} onFiles={noop} onBack={noop} onCall={noop} onSettings={noop} onComputer={noop} onRefresh={noop} />;
  else if (screen === 'boards') body = <Chat api={fake} bot={BOTS[0]} bots={BOTS} rows={BOARD_ROWS} onFiles={noop} onBack={noop} onCall={noop} onSettings={noop} onComputer={noop} onRefresh={noop} />;
  else if (screen === 'a2ui') body = <Chat api={fake} bot={BOTS[1]} rows={A2UI_ROWS} onFiles={noop} onBack={noop} onCall={noop} onSettings={noop} onComputer={noop} onRefresh={noop} />;
  else if (screen === 'views') body = <Chat api={fake} bot={BOTS[1]} rows={VIEW_ROWS} onFiles={noop} onBack={noop} onCall={noop} onSettings={noop} onComputer={noop} onRefresh={noop} />;
  else if (screen === 'files') body = <Files api={fake} bot={BOTS[1]} onBack={noop} />;
  else if (screen === 'page') body = <Files api={fake} bot={BOTS[1]} startPath="Weekend trip plan.page.json" onBack={noop} />;
  else if (screen.startsWith('file-')) body = <Files api={fake} bot={BOTS[1]} startPath={DEMO_FILES[Number(screen.split('-')[1])].path} onBack={noop} />;
  else if (screen === 'devices') body = <Devices api={fake} onBack={noop} />;
  else if (screen === 'usage') body = <Usage api={fake} onBack={noop} />;
  else if (screen === 'logins') body = <SavedLogins api={fake} onBack={noop} />;
  else if (screen === 'activity') body = <Activity api={fake} onBack={noop} />;
  else if (screen === 'system') body = <SystemStatus api={fake} onBack={noop} />;
  else if (screen === 'permissions') body = <Permissions api={fake} onBack={noop} />;
  else if (screen === 'botscomputer') body = <BotsComputer api={fake} bots={bots} onBack={noop} />;
  else if (screen === 'devicelink') body = <DeviceLink api={fake} onBack={noop} />;
  else if (screen === 'exchanges') body = <Exchanges api={fake} bot={BOTS.find((x) => x.id === 'sheldon')!} bots={bots} onBack={noop} onOpenChatGPT={noop} />;
  else if (screen === 'pages') body = <Pages api={fake} bot={BOTS[1]} onBack={noop} onOpen={noop} />;
  else if (screen === 'tasks') body = <Tasks api={fake} bots={bots} onBack={noop} onOpen={noop} />;
  // What the app shows while the bot list loads, when it could not load, and with no connection.
  else if (screen === 'homeloading') body = <Home api={fake} bots={[]} name="Alex" refreshing={false} loading onRefresh={noop} onOpen={noop} onNewBot={noop} onNewGroup={noop} onTasks={noop} onSignOut={noop} />;
  else if (screen === 'homeerror') body = <Home api={fake} bots={[]} name="Alex" refreshing={false} loadError="The server took too long to answer." onRetry={noop} onRefresh={noop} onOpen={noop} onNewBot={noop} onNewGroup={noop} onTasks={noop} onSignOut={noop} />;
  else if (screen === 'offline' || screen === 'reconnecting' || screen === 'updating') body = <><ConnectionBanner state={screen} saved onRetry={noop} /><Home api={fake} bots={bots} name="Alex" refreshing={false} onRefresh={noop} onOpen={noop} onNewBot={noop} onNewGroup={noop} onTasks={noop} onSignOut={noop} /></>;
  // A screen that failed to draw, and one row that did.
  else if (screen === 'crash') body = <ErrorBoundary where="preview" onBack={noop}><Boom /></ErrorBoundary>;
  else if (screen === 'rowcrash') body = <View style={{ padding: 16, paddingTop: 80, gap: 12 }}><RowGuard what="message"><Boom /></RowGuard><RowGuard what="card"><Boom /></RowGuard></View>;
  // Opened with two unread messages (the New line), and a code block with its Copy button.
  else if (screen === 'newline') body = <Chat api={fake} bot={{ ...b, unread: 2 }} bots={BOTS} loaded rows={[...ROWS.slice(0, 3), msg('assistant', 'Here is the script:\n\n```python\nfor bill in bills:\n    print(bill.name, bill.due)\n```\n\nRun it from the **Bills** folder.', 3 * min), msg('assistant', 'Also: the water bill went up $6 this month.', 2 * min)]} onBack={noop} onCall={noop} onSettings={noop} onComputer={noop} onRefresh={noop} />;
  else if (screen === 'appearance') body = <View style={{ padding: 16, paddingTop: 60 }}><Appearance /></View>;
  else if (screen === 'pcs') body = <Pcs api={fake} bots={bots} onBack={noop} onWatch={noop} />;
  else if (screen === 'call') body = <Call api={fake} bot={b} rows={[]} onBack={noop} demo={{ ...CALL_DEMO, captions: [...CALL_DEMO.captions] }} />;
  else if (screen === 'callerror') body = <Call api={fake} bot={b} rows={[]} onBack={noop} demo={{ ...CALL_ERROR, captions: [] }} />;
  else if (screen === 'split') {
    // The unfolded layout App.tsx uses on a wide screen: the list beside the open chat, with the divider.
    // &listw=N starts the list N wide (96 is the column of pictures, 0 a full-screen chat).
    body = <SplitDemo bots={bots} b={b} listw={params.get('listw')} />;
  }
  else body = <Home api={fake} bots={bots} name="Alex" refreshing={false} onRefresh={noop} onOpen={noop} onNewBot={noop} onNewGroup={noop} onTasks={noop} onSignOut={noop} />;
  return (
    <SafeAreaProvider>
      <View style={{ flex: 1, backgroundColor: color.ground }}>{body}</View>
    </SafeAreaProvider>
  );
}
