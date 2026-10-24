// Dates relative to today, so tests never go stale.
// "2030-05-01" is in the future today and in the past one day; daysFromToday(30) never is.

export function daysFromToday(days: number, today: Date = new Date()): string {
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + days));
  return d.toISOString().slice(0, 10);
}
