import { describe, expect, it } from 'vitest';
import { deriveDirectStartUrl, shouldAcceptRolledBookingCompletion } from '../src/runner/direct-start.js';

const BEFORE_BENCHMARK_DATES = new Date('2025-01-01T00:00:00Z');

function params(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

describe('deriveDirectStartUrl', () => {
  it('builds Booking search results URLs for explicit date ranges', () => {
    const result = deriveDirectStartUrl({
      startUrl: 'https://www.booking.com/',
      goal: 'Find a well-reviewed hotel in Paris with available bookings suitable for a couple (2 adults) on Valentine\'s Day week, February 14-21, 2026, that offers free cancellation options.',
    }, { now: BEFORE_BENCHMARK_DATES });

    expect(result?.profile).toBe('booking-search');
    const search = params(result!.url);
    expect(search.get('ss')).toBe('Paris');
    expect(search.get('checkin')).toBe('2026-02-14');
    expect(search.get('checkout')).toBe('2026-02-21');
    expect(search.get('group_adults')).toBe('2');
  });

  it('handles numeric date ranges and room counts', () => {
    const result = deriveDirectStartUrl({
      startUrl: 'https://www.booking.com/',
      goal: 'Get the hotel with highest review score and free cancelation in Chennai for 20/12/2025 - 21/12/2025.',
    }, { now: BEFORE_BENCHMARK_DATES });

    const search = params(result!.url);
    expect(search.get('ss')).toBe('Chennai');
    expect(search.get('checkin')).toBe('2025-12-20');
    expect(search.get('checkout')).toBe('2025-12-21');
  });

  it('converts stay duration into checkout date', () => {
    const result = deriveDirectStartUrl({
      startUrl: 'https://www.booking.com/',
      goal: 'Find the cheapest available hotel room for a three night stay from 1st Jan in Jakarta. The room is for 2 adults.',
    }, { now: BEFORE_BENCHMARK_DATES });

    const search = params(result!.url);
    expect(search.get('ss')).toBe('Jakarta');
    expect(search.get('checkin')).toBe('2026-01-01');
    expect(search.get('checkout')).toBe('2026-01-04');
    expect(search.get('group_adults')).toBe('2');
  });

  it('supports day-month date ranges in parentheses', () => {
    const result = deriveDirectStartUrl({
      startUrl: 'https://www.booking.com/',
      goal: 'I need to choose a hotel in Shenzhen, please select date (6 March to 8 March 2026) and click the search button.',
    }, { now: BEFORE_BENCHMARK_DATES });

    const search = params(result!.url);
    expect(search.get('ss')).toBe('Shenzhen');
    expect(search.get('checkin')).toBe('2026-03-06');
    expect(search.get('checkout')).toBe('2026-03-08');
  });

  it('does not rewrite non-Booking starts or Booking information tasks', () => {
    expect(deriveDirectStartUrl({
      startUrl: 'https://www.google.com/travel/flights',
      goal: 'Find a hotel in Paris from February 14-21, 2026.',
    }, { now: BEFORE_BENCHMARK_DATES })).toBeUndefined();

    expect(deriveDirectStartUrl({
      startUrl: 'https://www.booking.com/',
      goal: 'Browse Booking\'s homepage to find out which company it belongs to.',
    }, { now: BEFORE_BENCHMARK_DATES })).toBeUndefined();
  });

  it('rolls stale live Booking dates forward to a bookable year', () => {
    const result = deriveDirectStartUrl({
      startUrl: 'https://www.booking.com/',
      goal: 'Find a hotel in Paris from February 14-21, 2026.',
    }, { now: new Date('2026-04-29T00:00:00Z') });

    const search = params(result!.url);
    expect(search.get('checkin')).toBe('2027-02-14');
    expect(search.get('checkout')).toBe('2027-02-21');
    expect(result?.dateRoll).toEqual({
      originalCheckin: '2026-02-14',
      originalCheckout: '2026-02-21',
      checkin: '2027-02-14',
      checkout: '2027-02-21',
    });
  });

  it('accepts verifier date-only rejections for intentional Booking date rolls', () => {
    const directStart = deriveDirectStartUrl({
      startUrl: 'https://www.booking.com/',
      goal: 'Search for hotels in Rio de Janeiro from March 1-7, 2026, check the Brands filter.',
    }, { now: new Date('2026-04-29T00:00:00Z') });

    expect(shouldAcceptRolledBookingCompletion(
      directStart,
      {
        achieved: false,
        confidence: 0.45,
        evidence: [],
        missing: ['The current page uses 2027 dates while the requested task says 2026.'],
      },
      'On Booking.com, visible Brands counts include Windsor 15 and ibis 9 for https://www.booking.com/searchresults.html?ss=Rio&checkin=2027-03-01&checkout=2027-03-07 .',
      {
        url: 'https://www.booking.com/searchresults.html?ss=Rio&checkin=2027-03-01&checkout=2027-03-07',
        snapshot: 'Brands Windsor 15 ibis 9 Novotel 5 Search results updated. Rio de Janeiro: 2,619 properties found.',
      },
    )).toBe(true);
  });

  it('does not accept rolled-date completions without concrete Booking evidence', () => {
    const directStart = deriveDirectStartUrl({
      startUrl: 'https://www.booking.com/',
      goal: 'Find a hotel in Paris from February 14-21, 2026.',
    }, { now: new Date('2026-04-29T00:00:00Z') });

    expect(shouldAcceptRolledBookingCompletion(
      directStart,
      {
        achieved: false,
        confidence: 0.45,
        evidence: [],
        missing: ['The current page uses 2027 dates while the requested task says 2026.'],
      },
      'I could not find a result for 2027-02-14 to 2027-02-21.',
      {
        url: 'https://www.booking.com/searchresults.html?ss=Paris&checkin=2027-02-14&checkout=2027-02-21',
        snapshot: 'Booking.com homepage',
      },
    )).toBe(false);
  });
});
