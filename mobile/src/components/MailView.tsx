import { Text, View } from 'react-native';
import { color, type } from '../theme';

/** An HTML email body as plain text for reading on the card. */
const mailText = (m: any) => typeof m.text === 'string' ? m.text : !m.html ? m.body : String(m.body)
  .replace(/<\s*(br|\/p|\/div|\/li|\/h\d)\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  .replace(/\n{3,}/g, '\n\n').trim();

/** The whole email a send card shows: who it is from and to, the subject, every word of the body and the attachments. */
export function MailView({ mail }: { mail: any }) {
  const line = (label: string, v: string) => !!v && (
    <Text selectable style={{ fontSize: 15, lineHeight: 21, color: color.ink }}><Text style={{ color: color.inkMuted }}>{label}  </Text>{v}</Text>
  );
  return (
    <View style={{ backgroundColor: color.surface, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14, gap: 4 }}>
      {line('From', mail.from)}
      {line('To', mail.to || (mail.replyAll ? 'Everyone on the thread (reply all)' : mail.threadId ? 'The thread\'s last sender (reply)' : '(nobody)'))}
      {line('Cc', mail.cc)}
      {line('Bcc', mail.bcc)}
      {line('Subject', mail.subject || (mail.threadId ? '(the thread\'s subject)' : mail.forwardOf ? '(Fwd: the original subject)' : '(no subject)'))}
      {!!mail.forwardOf && <Text style={type.caption}>Forwards an earlier email, with its text below this note.</Text>}
      <Text selectable style={{ fontSize: 16, lineHeight: 23, color: color.ink, marginTop: 8 }}>{mailText(mail) || '(empty)'}</Text>
      {mail.attachments?.length > 0 && <Text style={[type.caption, { marginTop: 8 }]}>📎 {mail.attachments.join(', ')}</Text>}
      {(mail.other ?? []).map((o: { name: string; value: string }) => <View key={o.name}>{line(o.name, o.value)}</View>)}
      {!!mail.incomplete && <Text style={[type.caption, { marginTop: 8, color: color.problemInk }]}>{mail.incomplete}</Text>}
    </View>
  );
}
