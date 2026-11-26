/**
 * "Download my data": everything this account holds on the server (every conversation as Markdown, each bot's
 * instructions and routines) as one JSON file, handed to Android's share sheet so it can be saved to Files,
 * Drive or anywhere else. The same file the web's Settings > Account > Download my data gives.
 */
import { Platform, Share } from 'react-native';
import { File as FsFile, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import type { Client } from './api';

export async function downloadMyData(api: Client): Promise<{ bots: number; conversations: number; messages: number }> {
  const data = await api.accountExport();
  const name = `ybots-data-${String(data.exportedAt ?? new Date().toISOString()).slice(0, 10)}.json`;
  const text = JSON.stringify(data, null, 2);
  if (Platform.OS === 'web' || !(await Sharing.isAvailableAsync())) { await Share.share({ message: text.slice(0, 100_000), title: name }); return data.counts; }
  const file = new FsFile(Paths.cache, name);
  if (file.exists) file.delete();
  file.create({ intermediates: true });
  file.write(text);
  await Sharing.shareAsync(file.uri, { mimeType: 'application/json', dialogTitle: 'Save your data' });
  return data.counts;
}
