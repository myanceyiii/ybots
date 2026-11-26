import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

/**
 * Pictures a person attaches are handed to the bot inside the message itself (Responses `input_image`
 * parts, data URLs), not as a path its tools must open. A bot's engine may run as another account that
 * cannot read the Library (Howard's Hermes runs as its own Linux user, and the Library is under /root), so a path
 * alone left it blind. Large or unusual pictures are shrunk to a JPEG with ImageMagick first; the engine
 * takes at most 10 MB per request, so the pictures of one message share a budget below that.
 */

const DIRECT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
/** Raw bytes per picture sent as it is; anything larger is shrunk. */
const KEEP_UNDER = 1_200_000;
/** Base64 characters for all the pictures of one message. */
const BUDGET = 7_000_000;

export interface ImagePart { type: 'input_image'; image_url: string }
export interface ImageMiss { name: string; why: string }

/** ImageMagick 7 is `magick`; ImageMagick 6 has only `convert`. */
const TOOLS = ['magick', 'convert'];

function shrinkWith(tool: string, file: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleft-img-'));
    const out = path.join(dir, 'p.jpg');
    const finish = (data: Buffer | null) => { fs.rmSync(dir, { recursive: true, force: true }); resolve(data); };
    const child = spawn(tool, [`${file}[0]`, '-auto-orient', '-resize', '1600x1600>', '-strip', '-quality', '82', `jpeg:${out}`], { stdio: 'ignore' });
    const kill = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.on('error', () => { clearTimeout(kill); finish(null); });
    child.on('close', (code) => {
      clearTimeout(kill);
      let data: Buffer | null = null;
      try { if (code === 0 && fs.existsSync(out)) data = fs.readFileSync(out); } catch { data = null; }
      finish(data);
    });
  });
}

async function shrink(file: string): Promise<Buffer | null> {
  for (const tool of TOOLS) {
    const data = await shrinkWith(tool, file);
    if (data) return data;
  }
  return null;
}

/** The pictures at these full paths as message parts, and the ones that could not be included (with why). */
export async function imageParts(files: string[]): Promise<{ parts: ImagePart[]; missed: ImageMiss[] }> {
  const parts: ImagePart[] = [];
  const missed: ImageMiss[] = [];
  let budget = BUDGET;
  for (const file of files) {
    const name = path.basename(file);
    const ext = name.toLowerCase().split('.').pop() ?? '';
    let data: Buffer | null = null;
    let mime = MIME[ext] ?? 'image/jpeg';
    try {
      const size = fs.statSync(file).size;
      if (DIRECT.has(ext) && size <= KEEP_UNDER) data = fs.readFileSync(file);
      else { data = await shrink(file); mime = 'image/jpeg'; }
    } catch { data = null; }
    if (!data) { missed.push({ name, why: 'it could not be read or converted on the server' }); continue; }
    const url = `data:${mime};base64,${data.toString('base64')}`;
    if (url.length > budget) { missed.push({ name, why: 'the pictures in this message are too large to send together' }); continue; }
    budget -= url.length;
    parts.push({ type: 'input_image', image_url: url });
  }
  return { parts, missed };
}
