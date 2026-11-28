// Demo A2UI views for the Android preview (?screen=a2ui) and the web dev fixtures (?fixtures=a2ui):
// a booking form with checks, a template list in cards with a Modal, and tabs. Built with the shared engine.
import { applyA2ui, surfaceText, A2UI_BASIC_CATALOG as CAT } from '../src/a2ui';

const booking = [
  { version: '1.0', createSurface: { surfaceId: 'booking', catalogId: CAT, dataModel: { party: 4, seating: ['patio'], name: '' } } },
  { version: '1.0', updateComponents: { surfaceId: 'booking', components: [
    { id: 'root', component: 'Column', children: ['head', 'name', 'party', 'seat', 'when', 'veg', 'btns'] },
    { id: 'head', component: 'Row', align: 'center', children: ['ic', 'title'] },
    { id: 'ic', component: 'Icon', name: 'event' },
    { id: 'title', component: 'Text', text: "**Table at Luigi's** · Friday" },
    { id: 'name', component: 'TextField', label: 'Name on the booking', placeholder: 'Your name', value: { '@path': '/name' }, '@checks': [{ condition: { '@call': 'required', args: { value: { '@path': '/name' } } }, message: 'Add a name' }] },
    { id: 'party', component: 'Slider', label: 'Party size', value: { '@path': '/party' }, min: 1, max: 8, steps: 7 },
    { id: 'seat', component: 'ChoicePicker', label: 'Seating', displayStyle: 'chips', options: [{ label: 'Inside', value: 'inside' }, { label: 'Patio', value: 'patio' }, { label: 'Bar', value: 'bar' }], value: { '@path': '/seating' } },
    { id: 'when', component: 'DateTimeInput', label: 'Time', enableTime: true, value: { '@path': '/when' } },
    { id: 'veg', component: 'CheckBox', label: 'Someone is vegetarian', value: { '@path': '/veg' } },
    { id: 'btns', component: 'Row', justify: 'end', children: ['menu', 'go'] },
    { id: 'menu_l', component: 'Text', text: 'See menu' },
    { id: 'menu', component: 'Button', variant: 'borderless', child: 'menu_l', action: { functionCall: { '@call': 'openUrl', args: { url: 'https://example.com/menu' } } } },
    { id: 'go_l', component: 'Text', text: 'Book it' },
    { id: 'go', component: 'Button', variant: 'primary', child: 'go_l', '@checks': [{ condition: { '@call': 'required', args: { value: { '@path': '/name' } } }, message: 'Add a name first' }],
      action: { event: { name: 'book', userMessage: { '@call': 'formatString', args: { value: 'Book a table for ${/party} under ${/name}' } }, context: { party: { '@path': '/party' }, seating: { '@path': '/seating' } } } } },
  ] } },
];

const plans = [
  { version: '1.0', createSurface: { surfaceId: 'plans', catalogId: CAT, dataModel: { plans: [
    { name: 'Mint Unlimited', price: 30, note: 'T-Mobile network', best: true },
    { name: 'Visible+', price: 45, note: 'Verizon network' },
    { name: 'Verizon Welcome', price: 65, note: 'Two lines, autopay' },
  ] } } },
  { version: '1.0', updateComponents: { surfaceId: 'plans', components: [
    { id: 'root', component: 'Tabs', tabs: [{ title: 'Plans', child: 'list' }, { title: 'Why switch', child: 'why' }] },
    { id: 'list', component: 'Column', children: { componentId: 'card', path: '/plans' } },
    { id: 'card', component: 'Card', child: 'row' },
    { id: 'row', component: 'Row', align: 'center', justify: 'spaceBetween', children: ['info', 'price'] },
    { id: 'info', component: 'Column', weight: 1, children: ['pname', 'pnote'] },
    { id: 'pname', component: 'Text', text: { '@call': 'formatString', args: { value: '**${name}**' } } },
    { id: 'pnote', component: 'Text', variant: 'caption', text: { '@path': 'note' } },
    { id: 'price', component: 'Text', text: { '@call': 'formatCurrency', args: { value: { '@path': 'price' }, currency: 'USD', decimals: 0 } } },
    { id: 'why', component: 'Column', children: ['whyt', 'more'] },
    { id: 'whyt', component: 'Text', text: 'You pay **$140** for two lines now. Mint would be **$60**, so about **$960 a year** less.' },
    { id: 'more', component: 'Modal', trigger: 'more_b', content: 'more_c' },
    { id: 'more_l', component: 'Text', text: 'How porting works' },
    { id: 'more_b', component: 'Button', child: 'more_l', action: { event: { name: 'noop' } } },
    { id: 'more_c', component: 'Text', text: "### Porting your number\nKeep your number: the new carrier asks for your account and transfer PIN, and the switch takes about an hour." },
  ] } },
];

function card(viewId: string, title: string, messages: unknown[]) {
  const { surface } = applyA2ui(null, messages);
  return { type: 'card', card: 'view', viewId, title, text: `**${title}**\n\n${surface ? surfaceText(surface) : ''}`, blocks: [{ id: 'v1', type: 'a2ui', surface }] } as any;
}

export const A2UI_DEMO = [
  { ask: 'Can you book us dinner at Luigi’s on Friday?', say: 'Sure. Fill this in and I will book it.', body: card('vw_a2ui_book', 'Dinner booking', booking) },
  { ask: 'Compare phone plans for us?', say: 'Mint is the cheapest that covers the house well.', body: card('vw_a2ui_plans', 'Phone plans', plans) },
];
