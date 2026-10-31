const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 60 * 60 * 24 * 365],
  ["month", 60 * 60 * 24 * 30],
  ["week", 60 * 60 * 24 * 7],
  ["day", 60 * 60 * 24],
  ["hour", 60 * 60],
  ["minute", 60],
];

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

// "3 days ago", "last month", "just now"
export function timeAgo(date: string | Date) {
  const seconds = (new Date(date).getTime() - Date.now()) / 1000;
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return "just now";
}

const shortDate = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });

// "2026-10-24" → "Oct 24". Parsed as a local date so it doesn't shift across time zones.
export function formatShortDate(isoDate: string) {
  const [year, month, day] = isoDate.split("-").map(Number);
  return formatDay(new Date(year, month - 1, day));
}

// Date → "Nov 1"
export function formatDay(date: Date) {
  return shortDate.format(date);
}

// Whether a YYYY-MM-DD date is before today, in local time.
export function isPastDate(isoDate: string) {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return isoDate < today;
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const usdWhole = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

// 1234 → "$12.34"; with `whole`, 5000 → "$50"
export function formatCents(cents: number, { whole = false } = {}) {
  return (whole ? usdWhole : usd).format(cents / 100);
}
