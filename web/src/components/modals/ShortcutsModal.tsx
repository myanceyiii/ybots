import { keyHint } from '../../lib/keys';
import { usePrefs } from '../../lib/prefs';
import { useStore } from '../../store';
import { Icon } from '../Icon';
import { Modal } from './Modal';

/** Every keyboard shortcut in one place. Opens with ? (when not typing) or Ctrl+/. */
export function ShortcutsModal() {
  const close = () => useStore.getState().setModal(null);
  const enterSends = usePrefs((s) => s.enterSends);
  const groups: { title: string; keys: [string, string][] }[] = [
    { title: 'Get around', keys: [
      [keyHint('K'), 'Search chats and every message'],
      [keyHint('↑', { alt: true, mod: false }) + ' / ' + keyHint('↓', { alt: true, mod: false }), 'Previous or next chat'],
      [keyHint('B'), 'Show or hide the chat list'],
      [keyHint('F', { shift: true }), 'Full-screen chat'],
      [keyHint(',', { shift: true }), 'Show or hide details'],
      [keyHint(','), 'Settings'],
      [keyHint('/'), 'This list'],
    ] },
    { title: 'Write', keys: [
      [enterSends ? 'Enter' : keyHint('Enter'), 'Send'],
      [enterSends ? 'Shift+Enter' : 'Enter', 'New line'],
      ['↑', 'Edit your last message (in an empty box)'],
      [keyHint('I'), 'Jump to the message box'],
      [keyHint('V'), 'Paste a picture or file to attach it'],
      ['@', 'Ask one Bot in a group chat'],
      ['Esc', 'Cancel a reply or an edit, close what is open'],
    ] },
    { title: 'Conversations', keys: [
      [keyHint('O', { shift: true }), 'New conversation (with Undo)'],
      ['Hold the mic', 'Dictate; release to stop'],
    ] },
  ];
  return (
    <Modal onClose={close} className="shortcuts-modal" label="Keyboard shortcuts">
      <div className="shortcuts__head">
        <h2>Keyboard shortcuts</h2>
        <button type="button" className="icon-btn icon-btn--plain" onClick={close} aria-label="Close"><Icon name="close" opacity={0.66} /></button>
      </div>
      <div className="shortcuts__body">
        {groups.map((g) => (
          <section key={g.title}>
            <h3>{g.title}</h3>
            <dl>
              {g.keys.map(([k, what]) => (<div key={what} className="shortcut"><dt><kbd>{k}</kbd></dt><dd>{what}</dd></div>))}
            </dl>
          </section>
        ))}
      </div>
      <div className="shortcuts__foot">What Enter does can be changed in Settings, General.</div>
    </Modal>
  );
}
