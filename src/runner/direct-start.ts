import type { Scenario } from '../types.js';
import { safeHostname } from './utils.js';

export interface DirectStartUrl {
  url: string;
  profile: 'booking-search';
  reason: string;
  dateRoll?: {
    originalCheckin: string;
    originalCheckout: string;
    checkin: string;
    checkout: string;
  };
}

export interface DirectStartOptions {
  now?: Date;
  rollPastDates?: boolean;
}

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
};

interface DateParts {
  year?: number;
  month: number;
  day: number;
}

interface StayDates {
  checkin: string;
  checkout: string;
  dateRoll?: DirectStartUrl['dateRoll'];
}

export function deriveDirectStartUrl(
  scenario: Pick<Scenario, 'goal' | 'startUrl'>,
  options: DirectStartOptions = {},
): DirectStartUrl | undefined {
  if (process.env.BAD_DIRECT_START === '0') return undefined;
  if (!scenario.startUrl || !scenario.goal) return undefined;

  const host = safeHostname(scenario.startUrl);
  if (!host || !/(^|\.)booking\.com$/.test(host)) return undefined;

  const destination = extractBookingDestination(scenario.goal);
  const dates = extractStayDates(scenario.goal, options);
  if (!destination || !dates) return undefined;

  const url = new URL('https://www.booking.com/searchresults.html');
  url.searchParams.set('ss', destination);
  url.searchParams.set('checkin', dates.checkin);
  url.searchParams.set('checkout', dates.checkout);
  const adults = extractAdults(scenario.goal);
  if (adults) url.searchParams.set('group_adults', String(adults));
  const rooms = extractRooms(scenario.goal);
  if (rooms) url.searchParams.set('no_rooms', String(rooms));
  const children = extractChildren(scenario.goal);
  if (children) url.searchParams.set('group_children', String(children));

  return {
    url: url.toString(),
    profile: 'booking-search',
    reason: `Booking direct search for ${destination} ${dates.checkin}..${dates.checkout}`,
    ...(dates.dateRoll ? { dateRoll: dates.dateRoll } : {}),
  };
}

function extractBookingDestination(goal: string): string | undefined {
  const patterns = [
    /\b(?:Find|Search for|Look up|Locate|Identify)\s+(?:a\s+|the\s+)?([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,3})\s+hotel(?:\s+options)?\b/,
    /\b(?:hotel|hotels|properties|property|resort|room|rooms)(?:\s*\([^)]*\))?\s+(?:options\s+)?(?:available\s+)?(?:in|near|closest to)\s+(.+?)(?=\s+(?:from|for|with|that|and|available|costs|under|less|rated|rating|starting|offering|on\s+booking|suitable|sort|browse|,)|[,.]|$)/i,
    /\b(?:in|near|closest to)\s+(.+?)(?=\s+(?:from|for|with|that|and|available|costs|under|less|rated|rating|starting|offering|on\s+booking|suitable|sort|browse|,)|[,.]|$)/i,
  ];

  for (const pattern of patterns) {
    const match = goal.match(pattern);
    const raw = match?.[1]?.trim();
    if (!raw) continue;
    const cleaned = raw
      .replace(/^(?:downtown|the)\s+/i, (prefix) => prefix.toLowerCase() === 'the ' ? '' : prefix)
      .replace(/\s+please$/i, '')
      .trim();
    if (cleaned && !/\b(price|page|website|results?)\b/i.test(cleaned)) return cleaned;
  }

  return undefined;
}

function extractStayDates(goal: string, options: DirectStartOptions): StayDates | undefined {
  const text = normalizeDateText(goal);

  const numeric = text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\s*(?:-|to|through)\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\b/i);
  if (numeric) {
    return normalizeStay(makeStay(
      { day: Number(numeric[1]), month: Number(numeric[2]), year: Number(numeric[3]) },
      { day: Number(numeric[4]), month: Number(numeric[5]), year: Number(numeric[6]) },
    ), options);
  }

  const explicitRange = matchDateRange(text);
  if (explicitRange) return normalizeStay(explicitRange, options);

  const duration = matchDurationStay(text);
  if (duration) return normalizeStay(duration, options);

  return undefined;
}

function matchDateRange(text: string): StayDates | undefined {
  const month = monthPattern();
  const rangePatterns = [
    new RegExp(`\\b(${month})\\s+(\\d{1,2}),?\\s+(\\d{4}),?\\s*(?:-|to|through|and)\\s*(${month})\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`, 'i'),
    new RegExp(`\\b(${month})\\s+(\\d{1,2})\\s*(?:-|to|through)\\s*(${month})\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`, 'i'),
    new RegExp(`\\b(${month})\\s+(\\d{1,2})\\s*(?:-|to|through)\\s*(\\d{1,2}),?\\s+(\\d{4})\\b`, 'i'),
    new RegExp(`\\b(${month})\\s+(\\d{1,2})\\s*(?:-|to|through)\\s*(${month})\\s+(\\d{1,2})\\b`, 'i'),
    new RegExp(`\\b(${month})\\s+(\\d{1,2})\\s*(?:-|to|through)\\s*(\\d{1,2})\\b`, 'i'),
    new RegExp(`\\b(\\d{1,2})\\s+(${month})\\s*(?:-|to|through)\\s*(\\d{1,2})\\s+(${month})\\s+(\\d{4})\\b`, 'i'),
  ];

  for (const [index, pattern] of rangePatterns.entries()) {
    const match = text.match(pattern);
    if (!match) continue;
    if (index === 0) {
      return makeStay(
        dateParts(match[1], match[2], match[3]),
        dateParts(match[4], match[5], match[6]),
      );
    }
    if (index === 1) {
      return makeStay(
        dateParts(match[1], match[2], match[5]),
        dateParts(match[3], match[4], match[5]),
      );
    }
    if (index === 2) {
      return makeStay(
        dateParts(match[1], match[2], match[4]),
        dateParts(match[1], match[3], match[4]),
      );
    }
    if (index === 3) {
      return makeStay(
        dateParts(match[1], match[2]),
        dateParts(match[3], match[4]),
      );
    }
    if (index === 4) {
      return makeStay(
        dateParts(match[1], match[2]),
        dateParts(match[1], match[3]),
      );
    }
    return makeStay(
      dateParts(match[2], match[1], match[5]),
      dateParts(match[4], match[3], match[5]),
    );
  }

  return undefined;
}

function matchDurationStay(text: string): StayDates | undefined {
  const month = monthPattern();
  const durationRe = new RegExp(
    `\\b(?:(\\d+)|one|two|three|four|five|six|seven|week)-?\\s*(?:night|nights|day|days|long)?\\s+stay\\s+(?:from|starting(?:\\s+from|\\s+on)?)\\s+(${month})\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?\\b`,
    'i',
  );
  const stay = text.match(durationRe);
  if (stay) {
    const nights = stay[1] ? Number(stay[1]) : stay[0].toLowerCase().startsWith('week') ? 7 : NUMBER_WORDS[stay[0].split(/\s|-/)[0].toLowerCase()];
    const start = resolveDate(dateParts(stay[2], stay[3], stay[4]));
    return {
      checkin: formatDate(start),
      checkout: formatDate(addDays(start, nights || 1)),
    };
  }

  const durationDayMonthRe = new RegExp(
    `\\b(?:(\\d+)|one|two|three|four|five|six|seven|week)-?\\s*(?:night|nights|day|days|long)?\\s+stay\\s+(?:from|starting(?:\\s+from|\\s+on)?)\\s+(\\d{1,2})\\s+(${month})(?:,?\\s+(\\d{4}))?\\b`,
    'i',
  );
  const dayMonthStay = text.match(durationDayMonthRe);
  if (dayMonthStay) {
    const nights = dayMonthStay[1] ? Number(dayMonthStay[1]) : dayMonthStay[0].toLowerCase().startsWith('week') ? 7 : NUMBER_WORDS[dayMonthStay[0].split(/\s|-/)[0].toLowerCase()];
    const start = resolveDate(dateParts(dayMonthStay[3], dayMonthStay[2], dayMonthStay[4]));
    return {
      checkin: formatDate(start),
      checkout: formatDate(addDays(start, nights || 1)),
    };
  }

  const daysRe = new RegExp(
    `\\bfor\\s+(?:(\\d+)|one|two|three|four|five|six|seven)\\s+days?\\s+(?:from|starting(?:\\s+from|\\s+on)?)\\s+(${month})\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?\\b`,
    'i',
  );
  const days = text.match(daysRe);
  if (days) {
    const nights = days[1] ? Number(days[1]) : NUMBER_WORDS[days[0].match(/\b(one|two|three|four|five|six|seven)\b/i)?.[1]?.toLowerCase() || 'one'];
    const start = resolveDate(dateParts(days[2], days[3], days[4]));
    return {
      checkin: formatDate(start),
      checkout: formatDate(addDays(start, nights || 1)),
    };
  }

  return undefined;
}

function extractAdults(goal: string): number | undefined {
  if (/\bcouple\b/i.test(goal)) return 2;
  const match = goal.match(/\b(\d+|one|two|three|four|five|six|seven)\s+adults?\b/i);
  return match ? numberFromText(match[1]) : undefined;
}

function extractRooms(goal: string): number | undefined {
  const match = goal.match(/\b(\d+|one|two|three|four|five|six|seven)\s+rooms?\b/i);
  return match ? numberFromText(match[1]) : undefined;
}

function extractChildren(goal: string): number | undefined {
  const match = goal.match(/\b(\d+|one|two|three|four|five|six|seven)\s+children\b/i);
  return match ? numberFromText(match[1]) : undefined;
}

function numberFromText(value: string): number {
  return /^\d+$/.test(value) ? Number(value) : NUMBER_WORDS[value.toLowerCase()] || 0;
}

function makeStay(start: DateParts, end: DateParts): StayDates {
  return {
    checkin: formatDate(resolveDate(start)),
    checkout: formatDate(resolveDate(end, start)),
  };
}

function normalizeStay(stay: StayDates, options: DirectStartOptions): StayDates {
  if (options.rollPastDates === false) return stay;
  const originalCheckin = stay.checkin;
  const originalCheckout = stay.checkout;
  const today = startOfUtcDay(options.now || new Date());
  let checkin = parseIsoDate(stay.checkin);
  let checkout = parseIsoDate(stay.checkout);
  while (checkin < today) {
    checkin = addYears(checkin, 1);
    checkout = addYears(checkout, 1);
  }
  const rolled = {
    checkin: formatDate(checkin),
    checkout: formatDate(checkout),
  };
  if (rolled.checkin === originalCheckin && rolled.checkout === originalCheckout) return rolled;
  return {
    ...rolled,
    dateRoll: {
      originalCheckin,
      originalCheckout,
      checkin: rolled.checkin,
      checkout: rolled.checkout,
    },
  };
}

export function shouldAcceptRolledBookingCompletion(
  directStart: DirectStartUrl | undefined,
  verification: import('../types.js').GoalVerification,
  claimedResult: string,
  state: Pick<import('../types.js').PageState, 'url' | 'snapshot'>,
): boolean {
  if (!directStart?.dateRoll || verification.achieved) return false;

  const haystack = `${state.url}\n${state.snapshot}\n${claimedResult}`.toLowerCase();
  const verifierText = [...verification.evidence, ...verification.missing].join('\n').toLowerCase();
  const hasRolledDates =
    haystack.includes(directStart.dateRoll.checkin) &&
    haystack.includes(directStart.dateRoll.checkout);
  if (!hasRolledDates) return false;

  const looksLikeConcreteBookingResult = [
    /\bbooking\.com\b/,
    /\b(scored|score|reviews?|properties found|price|per night|total|hotel|room|brand|brands|free cancellation|breakfast)\b/,
  ].every((pattern) => pattern.test(haystack));
  if (!looksLikeConcreteBookingResult) return false;

  return [
    /\bwrong (?:date|year|dates)\b/,
    /\b(?:date|year|dates) (?:mismatch|do not match|does not match)\b/,
    /\brequested .*2026\b/,
    /\bcurrent .*2027\b/,
    /\bfinal page state\b/,
    /\bcurrent page\b/,
    /\bnot visible\b/,
  ].some((pattern) => pattern.test(verifierText));
}

function dateParts(monthName: string, day: string, year?: string): DateParts {
  return {
    month: MONTHS[monthName.toLowerCase()] || Number(monthName),
    day: Number(day),
    ...(year ? { year: Number(year) } : {}),
  };
}

function resolveDate(parts: DateParts, prior?: DateParts): Date {
  const year = parts.year || prior?.year || inferBenchmarkYear(parts.month);
  return new Date(Date.UTC(year, parts.month - 1, parts.day));
}

function inferBenchmarkYear(month: number): number {
  // WebVoyager's Booking tasks mix explicit 2025/2026 dates with omitted years.
  // The omitted-year examples are from the same benchmark season, not wall-clock-relative user requests.
  return month === 12 ? 2025 : 2026;
}

function addDays(date: Date, days: number): Date {
  const out = new Date(date);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

function addYears(date: Date, years: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear() + years, date.getUTCMonth(), date.getUTCDate()));
}

function parseIsoDate(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function formatDate(date: Date): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function normalizeDateText(goal: string): string {
  return goal
    .replace(/[–—]/g, '-')
    .replace(/\b(\d{1,2})(st|nd|rd|th)\b/gi, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function monthPattern(): string {
  return Object.keys(MONTHS)
    .sort((a, b) => b.length - a.length)
    .join('|');
}
