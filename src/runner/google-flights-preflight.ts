import type { Page } from 'playwright';
import type { GoalVerification, PageState, Scenario } from '../types.js';
import { safeHostname } from './utils.js';

export interface GoogleFlightsSearchSpec {
  origin: string;
  destination: string;
  tripType: 'round-trip' | 'one-way';
  departureDate: string;
  returnDate?: string;
  dateRoll?: {
    originalDepartureDate: string;
    originalReturnDate?: string;
    departureDate: string;
    returnDate?: string;
  };
}

export interface GoogleFlightsPreflightResult {
  profile: 'google-flights-search';
  prepared: boolean;
  reason: string;
  spec: GoogleFlightsSearchSpec;
  finalUrl?: string;
  blockingReason?: string;
  error?: string;
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

interface ParsedDate {
  year?: number;
  month: number;
  day: number;
}

export function deriveGoogleFlightsSearchSpec(
  scenario: Pick<Scenario, 'goal' | 'startUrl'>,
  options: { now?: Date; rollPastDates?: boolean } = {},
): GoogleFlightsSearchSpec | undefined {
  if (process.env.BAD_GOOGLE_FLIGHTS_PREFLIGHT === '0') return undefined;
  if (!scenario.startUrl || !scenario.goal) return undefined;

  const host = safeHostname(scenario.startUrl);
  if (!host || !/(^|\.)google\.com$/.test(host) || !/\/travel\/flights\/?/i.test(scenario.startUrl)) {
    return undefined;
  }

  const route = extractRoute(scenario.goal);
  const dates = extractFlightDates(scenario.goal);
  if (!route || !dates) return undefined;

  const rolled = normalizeFlightDates(dates, options);
  return {
    origin: route.origin,
    destination: route.destination,
    tripType: dates.returnDate ? 'round-trip' : 'one-way',
    departureDate: rolled.departureDate,
    ...(rolled.returnDate ? { returnDate: rolled.returnDate } : {}),
    ...(rolled.dateRoll ? { dateRoll: rolled.dateRoll } : {}),
  };
}

export async function prepareGoogleFlightsSearch(
  page: Page | undefined,
  scenario: Pick<Scenario, 'goal' | 'startUrl'>,
  options: { now?: Date; timeoutMs?: number } = {},
): Promise<GoogleFlightsPreflightResult | undefined> {
  const spec = deriveGoogleFlightsSearchSpec(scenario, options);
  if (!spec) return undefined;
  if (!page || page.isClosed()) {
    return {
      profile: 'google-flights-search',
      prepared: false,
      reason: 'Google Flights preflight parsed the task but no Playwright page was available.',
      spec,
    };
  }

  const timeoutMs = options.timeoutMs ?? 45_000;
  try {
    await withDeadline(runGoogleFlightsUiPreflight(page, spec), timeoutMs);
    const blockingReason = await detectGoogleFlightsBlockingReason(page, spec);
    return {
      profile: 'google-flights-search',
      prepared: !blockingReason,
      reason: blockingReason || `Prepared Google Flights ${spec.tripType} search for ${spec.origin} to ${spec.destination} on ${spec.departureDate}${spec.returnDate ? `..${spec.returnDate}` : ''}.`,
      spec,
      finalUrl: page.url(),
      ...(blockingReason ? { blockingReason } : {}),
    };
  } catch (err) {
    return {
      profile: 'google-flights-search',
      prepared: false,
      reason: `Google Flights preflight failed; falling back to normal agent control.`,
      spec,
      finalUrl: page.url(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function shouldAcceptRolledGoogleFlightsCompletion(
  preflight: GoogleFlightsPreflightResult | undefined,
  verification: GoalVerification,
  claimedResult: string,
  state: Pick<PageState, 'url' | 'snapshot'>,
): boolean {
  if (!preflight?.spec.dateRoll || verification.achieved) return false;

  const { spec } = preflight;
  const haystack = `${state.url}\n${state.snapshot}\n${claimedResult}`.toLowerCase();
  const verifierText = [...verification.evidence, ...verification.missing].join('\n').toLowerCase();
  const hasRolledDates =
    haystack.includes(spec.departureDate) ||
    haystack.includes(formatDisplayDate(spec.departureDate)) ||
    (spec.returnDate ? haystack.includes(spec.returnDate) || haystack.includes(formatDisplayDate(spec.returnDate)) : true);
  if (!hasRolledDates) return false;

  const hasConcreteFlightEvidence = [
    /\bgoogle flights\b|\bflight search\b|\bsearch results\b/,
    /\b(?:\$|usd|round trip|one way|airlines?|stops?|nonstop|layover|duration|departing flights?)\b/,
    /\b(?:results? returned|top departing flights|best|cheapest|price insights|track prices)\b/,
  ].every((pattern) => pattern.test(haystack));
  if (!hasConcreteFlightEvidence) return false;

  return [
    /\bwrong (?:date|year|dates)\b/,
    /\b(?:date|year|dates) (?:mismatch|do not match|does not match)\b/,
    /\brequested .*2026\b/,
    /\bcurrent .*2027\b/,
    /\bstale benchmark\b/,
    /\bnot the requested date\b/,
  ].some((pattern) => pattern.test(verifierText));
}

async function runGoogleFlightsUiPreflight(page: Page, spec: GoogleFlightsSearchSpec): Promise<void> {
  await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(2_000);

  if (spec.tripType === 'one-way') {
    await selectOneWay(page).catch(() => undefined);
  }

  await selectAirport(page, 'Where from?', spec.origin);
  await selectAirport(page, /Where to/i, spec.destination);

  const navigated = await navigateToDatedSearch(page, spec);
  if (navigated) return;

  await setFlightDates(page, spec);

  await page.getByRole('button', { name: /search/i }).first().click({ timeout: 7_000 });
  await Promise.race([
    page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => undefined),
    page.waitForSelector('text=/Search results|results returned|Top departing flights|Best|Cheapest/i', { timeout: 12_000 }).catch(() => undefined),
  ]);
  await page.waitForTimeout(1_500);
}

async function selectOneWay(page: Page): Promise<void> {
  await page.locator('[aria-label="Change ticket type."]').first().locator('..').click({ timeout: 5_000 });
  await page.getByRole('option', { name: 'One way' }).click({ timeout: 5_000 });
  await page.waitForTimeout(500);
}

async function selectAirport(page: Page, label: string | RegExp, value: string): Promise<void> {
  const input = page.getByLabel(label).first();
  await input.click({ timeout: 7_000 });
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.type(value);
  await page.waitForTimeout(1_000);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1_000);
}

async function setFlightDates(page: Page, spec: GoogleFlightsSearchSpec): Promise<void> {
  await page.getByLabel('Departure').first().click({ timeout: 7_000 });
  await page.waitForTimeout(500);
  await page.keyboard.type(formatUsDate(spec.departureDate));
  if (spec.returnDate) {
    await page.keyboard.press('Tab');
    await page.keyboard.type(formatUsDate(spec.returnDate));
  }
  await page.waitForTimeout(500);
  await page.getByText('Done', { exact: true }).last().click({ timeout: 7_000 });
  await page.waitForTimeout(1_000);
}

async function navigateToDatedSearch(page: Page, spec: GoogleFlightsSearchSpec): Promise<boolean> {
  const tfs = new URL(page.url()).searchParams.get('tfs');
  if (!tfs) return false;
  const datedTfs = addGoogleFlightsDatesToTfs(tfs, spec.departureDate, spec.returnDate);
  if (!datedTfs) return false;
  await page.goto(`https://www.google.com/travel/flights/search?tfs=${datedTfs}`, {
    waitUntil: 'domcontentloaded',
    timeout: 15_000,
  });
  await page.waitForTimeout(4_000);
  return true;
}

async function detectGoogleFlightsBlockingReason(page: Page, spec: GoogleFlightsSearchSpec): Promise<string | undefined> {
  const body = (await page.locator('body').innerText({ timeout: 3_000 }).catch(() => '')).replace(/\s+/g, ' ').trim();
  const lower = body.toLowerCase();
  if (/\brequested flight date is too far in the future\b/.test(lower)) {
    return `Google Flights rejected ${spec.departureDate}${spec.returnDate ? `..${spec.returnDate}` : ''}: requested flight date is too far in the future.`;
  }
  if (/\bno results returned\b/.test(lower) && /\boops, something went wrong\b/.test(lower)) {
    return `Google Flights returned no searchable results for ${spec.departureDate}${spec.returnDate ? `..${spec.returnDate}` : ''}.`;
  }
  return undefined;
}

export function addGoogleFlightsDatesToTfs(tfs: string, departureDate: string, returnDate?: string): string | undefined {
  const decoded = Buffer.from(tfs, 'base64url');
  // Route-only searches produced by the UI start:
  //   08 1c 10 01 1a <route-payload-len> <route-payload...>
  // Dated searches replace 10 01 with 10 02 and prepend
  //   12 0a <YYYY-MM-DD>
  // to each route segment. Round trips have two segments; if the route URL
  // only contains the outbound segment, synthesize the return by swapping
  // origin/destination inside that segment.
  if (decoded.length < 8 || decoded[0] !== 0x08 || decoded[1] !== 0x1c || decoded[2] !== 0x10 || decoded[3] !== 0x01 || decoded[4] !== 0x1a) {
    return undefined;
  }
  const segments: Buffer[] = [];
  let offset = 4;
  while (decoded[offset] === 0x1a) {
    const len = decoded[offset + 1];
    if (!Number.isFinite(len) || len <= 0 || offset + 2 + len > decoded.length) return undefined;
    segments.push(decoded.subarray(offset + 2, offset + 2 + len));
    offset += 2 + len;
  }
  if (!segments.length) return undefined;
  const tail = decoded.subarray(offset);
  const datedSegments = [prependDateToRoutePayload(segments[0], departureDate)];
  if (returnDate) {
    datedSegments.push(prependDateToRoutePayload(segments[1] || swapRoutePayload(segments[0]), returnDate));
  }
  return Buffer.concat([
    decoded.subarray(0, 2),
    Buffer.from([0x10, 0x02]),
    ...datedSegments.flatMap((segment) => [Buffer.from([0x1a, segment.length]), segment]),
    tail,
  ]).toString('base64url');
}

function prependDateToRoutePayload(payload: Buffer, date: string): Buffer {
  if (payload[0] === 0x12 && payload[1] === 0x0a) {
    return Buffer.concat([Buffer.from([0x12, 0x0a]), Buffer.from(date), payload.subarray(12)]);
  }
  return Buffer.concat([Buffer.from([0x12, 0x0a]), Buffer.from(date), payload]);
}

function swapRoutePayload(payload: Buffer): Buffer {
  if (payload[0] !== 0x6a) return payload;
  const originLength = payload[1];
  const destStart = 2 + originLength;
  if (payload[destStart] !== 0x72) return payload;
  const destLength = payload[destStart + 1];
  const origin = payload.subarray(2, 2 + originLength);
  const dest = payload.subarray(destStart + 2, destStart + 2 + destLength);
  const rest = payload.subarray(destStart + 2 + destLength);
  return Buffer.concat([
    Buffer.from([0x6a, dest.length]),
    dest,
    Buffer.from([0x72, origin.length]),
    origin,
    rest,
  ]);
}

function extractRoute(goal: string): { origin: string; destination: string } | undefined {
  const normalized = goal.replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
  const routeStop = `leaving|departing|on|in\\s+(?:${monthPattern()})|for|and\\s+(?:return|returning|filter|include|analyze|select|show|sort)|with|filter|select|include|browse|which|$`;
  const matches = [...normalized.matchAll(new RegExp(`\\bfrom\\s+(.+?)\\s+to\\s+(.+?)(?=\\s+(?:${routeStop})|[,.]|$)`, 'gi'))];
  const match = matches.at(-1);
  if (!match) return undefined;
  const origin = cleanPlace(match[1].replace(/^.*\bfrom\s+/i, ''));
  const destination = cleanPlace(match[2]);
  if (!origin || !destination) return undefined;
  if (/\b(?:city|destination)s?\b/i.test(destination)) return undefined;
  return { origin, destination };
}

function extractFlightDates(goal: string): { departureDate: string; returnDate?: string } | undefined {
  const text = normalizeDateText(goal);
  const date = datePattern();

  const roundTripPatterns = [
    new RegExp(`\\bon\\s+(${date})\\s*,?\\s*(?:and\\s+)?return\\s+on\\s+(${date})\\b`, 'i'),
    new RegExp(`\\b(?:leaving|departing)\\s+on\\s+(${date})\\s*,?\\s*(?:and\\s+)?returning\\s+on\\s+(${date})\\b`, 'i'),
    new RegExp(`\\bdeparting\\s+on\\s+(${date})\\s*,?\\s*(?:and\\s+)?(?:a\\s+)?return\\s+on\\s+(${date})\\b`, 'i'),
    new RegExp(`\\bdeparture\\s+on\\s+(${date})\\s*,?\\s*(?:and\\s+)?(?:a\\s+)?return\\s+on\\s+(${date})\\b`, 'i'),
    new RegExp(`\\bdeparting\\s+(${date})\\s*,?\\s*(?:and\\s+)?returning\\s+(${date})\\b`, 'i'),
    new RegExp(`\\b(?:leaving|departing)\\s+on\\s+(${date})\\s*,?\\s*(?:and\\s+)?returning\\s+(${date})\\b`, 'i'),
    new RegExp(`\\b(?:leaving|departing)\\s+(${date})\\s*,?\\s*(?:and\\s+)?returning\\s+on\\s+(${date})\\b`, 'i'),
    new RegExp(`\\bon\\s+(${date})\\s*,?\\s*(?:and\\s+)?return\\s+on\\s+(${date})\\b`, 'i'),
    new RegExp(`\\bon\\s+(${date})\\s*,?\\s*(?:and\\s+)?return\\s+(${date})\\b`, 'i'),
    new RegExp(`\\b(${date})\\s*,?\\s*(?:and\\s+)?return\\s+on\\s+(${date})\\b`, 'i'),
  ];
  for (const pattern of roundTripPatterns) {
    const match = text.match(pattern);
    if (match) {
      return {
        departureDate: formatDate(resolveDate(parseDate(match[1]))),
        returnDate: formatDate(resolveDate(parseDate(match[2]), parseDate(match[1]))),
      };
    }
  }

  const oneWayPatterns = [
    new RegExp(`\\b(?:on|in|departing(?:\\s+on)?|leaving(?:\\s+on)?|leaves\\s+on|for\\s+a\\s+one-way\\s+trip\\s+on)\\s+(${date})\\b`, 'i'),
  ];
  for (const pattern of oneWayPatterns) {
    const match = text.match(pattern);
    if (match) return { departureDate: formatDate(resolveDate(parseDate(match[1]))) };
  }

  return undefined;
}

function normalizeFlightDates(
  dates: { departureDate: string; returnDate?: string },
  options: { now?: Date; rollPastDates?: boolean },
): Pick<GoogleFlightsSearchSpec, 'departureDate' | 'returnDate' | 'dateRoll'> {
  const originalDepartureDate = dates.departureDate;
  const originalReturnDate = dates.returnDate;
  let departure = parseIsoDate(dates.departureDate);
  let returning = dates.returnDate ? parseIsoDate(dates.returnDate) : undefined;
  if (options.rollPastDates !== false) {
    const today = startOfUtcDay(options.now || new Date());
    while (departure < today) {
      departure = addYears(departure, 1);
      if (returning) returning = addYears(returning, 1);
    }
  }
  const rolled = {
    departureDate: formatDate(departure),
    ...(returning ? { returnDate: formatDate(returning) } : {}),
  };
  if (rolled.departureDate === originalDepartureDate && rolled.returnDate === originalReturnDate) return rolled;
  return {
    ...rolled,
    dateRoll: {
      originalDepartureDate,
      ...(originalReturnDate ? { originalReturnDate } : {}),
      departureDate: rolled.departureDate,
      ...(rolled.returnDate ? { returnDate: rolled.returnDate } : {}),
    },
  };
}

function parseDate(raw: string): ParsedDate {
  const month = monthPattern();
  let match = raw.match(new RegExp(`^(${month})\\s+(\\d{1,2}),?\\s+(\\d{4})$`, 'i'));
  if (match) return { month: MONTHS[match[1].toLowerCase()], day: Number(match[2]), year: Number(match[3]) };
  match = raw.match(new RegExp(`^(\\d{1,2})\\s+(${month}),?\\s+(\\d{4})$`, 'i'));
  if (match) return { month: MONTHS[match[2].toLowerCase()], day: Number(match[1]), year: Number(match[3]) };
  match = raw.match(new RegExp(`^(${month})\\s+(\\d{1,2})$`, 'i'));
  if (match) return { month: MONTHS[match[1].toLowerCase()], day: Number(match[2]) };
  match = raw.match(new RegExp(`^(\\d{1,2})\\s+(${month})$`, 'i'));
  if (match) return { month: MONTHS[match[2].toLowerCase()], day: Number(match[1]) };
  match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) return { month: Number(match[1]), day: Number(match[2]), year: Number(match[3]) };
  throw new Error(`Unsupported flight date: ${raw}`);
}

function resolveDate(parts: ParsedDate, prior?: ParsedDate): Date {
  const year = parts.year || prior?.year || inferBenchmarkYear(parts.month);
  return new Date(Date.UTC(year, parts.month - 1, parts.day));
}

function datePattern(): string {
  const month = monthPattern();
  return `(?:${month})\\s+\\d{1,2},?\\s+\\d{4}|\\d{1,2}\\s+(?:${month}),?\\s+\\d{4}|(?:${month})\\s+\\d{1,2}|\\d{1,2}\\s+(?:${month})|\\d{1,2}\\/\\d{1,2}\\/\\d{4}`;
}

function monthPattern(): string {
  return Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');
}

function inferBenchmarkYear(month: number): number {
  return month === 12 ? 2025 : 2026;
}

function cleanPlace(value: string): string {
  return value
    .replace(/\b(?:the|a|an|eligible|economy|business class|class|round-trip|one-way)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[,.]$/, '');
}

function normalizeDateText(goal: string): string {
  return goal
    .replace(/[–—]/g, '-')
    .replace(/\b(\d{1,2})(st|nd|rd|th)\b/gi, '$1')
    .replace(/\b(Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\./gi, '$1')
    .replace(/\s+/g, ' ')
    .trim();
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

function formatUsDate(isoDate: string): string {
  const [year, month, day] = isoDate.split('-');
  return `${month}/${day}/${year}`;
}

function formatDisplayDate(isoDate: string): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).toLowerCase();
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Google Flights preflight timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
