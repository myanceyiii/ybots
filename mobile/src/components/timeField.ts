/** A time of day as the server keeps it for quiet hours: "HH:mm", 24-hour. */
export const isTime = (t: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t);

/** `t` moved by `minutes` (wrapping round midnight). A minute step keeps the hour; an hour step keeps the minutes. */
export function addMinutes(t: string, minutes: number): string {
  const [h, m] = t.split(':').map(Number);
  if (Math.abs(minutes) < 60) {
    const mm = (((m + minutes) % 60) + 60) % 60;
    return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }
  const total = ((((h * 60 + m + minutes) % 1440) + 1440) % 1440);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
