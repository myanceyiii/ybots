/**
 * Text for the server log: email addresses and things shaped like keys or tokens are masked, so a log
 * line from an app, a plugin or a failed sign-in never carries an account's address or a secret.
 * The rest of the line (which app, what failed and why) is kept: that is what the log is for.
 */
export function redact(text: string, max = 500): string {
  return String(text ?? '')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (m) => `${m[0]}…@${m.split('@')[1].split('.').pop()}`)
    .replace(/\b(Bearer|token|key|secret|password|passwd|authorization)(["'\s:=]+)([^\s"',;]{6,})/gi, '$1$2[hidden]')
    .replace(/\b(sk|pk|ghp|gho|ghs|xox[abp]|ya29|AIza)[-_.A-Za-z0-9]{10,}/g, '[hidden]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '[hidden]')
    .replace(/\b[a-f0-9]{40,}\b/gi, '[hidden]')
    .slice(0, max);
}
