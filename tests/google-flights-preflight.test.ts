import { describe, expect, it } from 'vitest';
import {
  addGoogleFlightsDatesToTfs,
  deriveGoogleFlightsSearchSpec,
  shouldAcceptRolledGoogleFlightsCompletion,
} from '../src/runner/google-flights-preflight.js';

describe('deriveGoogleFlightsSearchSpec', () => {
  it('parses and rolls stale round-trip Google Flights goals', () => {
    const spec = deriveGoogleFlightsSearchSpec({
      startUrl: 'https://www.google.com/travel/flights/',
      goal: 'Search for the cheapest round-trip flights from Bangkok to Madrid, leaving on February 26, 2026, and returning on February 28, 2026, and provide options under $1000.',
    }, { now: new Date('2026-04-29T00:00:00Z') });

    expect(spec).toEqual({
      origin: 'Bangkok',
      destination: 'Madrid',
      tripType: 'round-trip',
      departureDate: '2027-02-26',
      returnDate: '2027-02-28',
      dateRoll: {
        originalDepartureDate: '2026-02-26',
        originalReturnDate: '2026-02-28',
        departureDate: '2027-02-26',
        returnDate: '2027-02-28',
      },
    });
  });

  it('parses one-way Google Flights goals', () => {
    const spec = deriveGoogleFlightsSearchSpec({
      startUrl: 'https://www.google.com/travel/flights/',
      goal: 'Locate a one-way flight from Johannesburg to Toronto on March 30, 2026, for one adult, and analyze the price trends for the following month.',
    }, { now: new Date('2026-01-01T00:00:00Z') });

    expect(spec).toMatchObject({
      origin: 'Johannesburg',
      destination: 'Toronto',
      tripType: 'one-way',
      departureDate: '2026-03-30',
    });
    expect(spec?.returnDate).toBeUndefined();
    expect(spec?.dateRoll).toBeUndefined();
  });

  it('parses route phrasings found in held-out Google Flights tasks', () => {
    expect(deriveGoogleFlightsSearchSpec({
      startUrl: 'https://www.google.com/travel/flights/',
      goal: 'Find the cheapest round-trip flight option from New York City to Tokyo for a departure on January 10, 2026, and a return on January 24, 2026.',
    }, { now: new Date('2026-04-29T00:00:00Z') })).toMatchObject({
      origin: 'New York City',
      destination: 'Tokyo',
      tripType: 'round-trip',
      departureDate: '2027-01-10',
      returnDate: '2027-01-24',
    });

    expect(deriveGoogleFlightsSearchSpec({
      startUrl: 'https://www.google.com/travel/flights/',
      goal: 'Compare flight options from New York to Tokyo for a round trip leaving on January 25, 2026, and returning on February 15, 2026, for one adult.',
    }, { now: new Date('2026-04-29T00:00:00Z') })).toMatchObject({
      origin: 'New York',
      destination: 'Tokyo',
      tripType: 'round-trip',
      departureDate: '2027-01-25',
      returnDate: '2027-02-15',
    });

    expect(deriveGoogleFlightsSearchSpec({
      startUrl: 'https://www.google.com/travel/flights/',
      goal: 'Compare flight options and find the lowest round trip fare from New York to London departing on January 10, 2026, and returning on January 17, 2026.',
    }, { now: new Date('2026-04-29T00:00:00Z') })).toMatchObject({
      origin: 'New York',
      destination: 'London',
      tripType: 'round-trip',
      departureDate: '2027-01-10',
      returnDate: '2027-01-17',
    });
  });

  it('parses early WebVoyager Google Flights phrasings without explicit years', () => {
    const now = new Date('2026-04-29T00:00:00Z');
    expect(deriveGoogleFlightsSearchSpec({
      startUrl: 'https://www.google.com/travel/flights/',
      goal: 'Show me the list of one-way flights on February 17, 2026 from Chicago to Paris.',
    }, { now })).toMatchObject({
      origin: 'Chicago',
      destination: 'Paris',
      tripType: 'one-way',
      departureDate: '2027-02-17',
    });

    expect(deriveGoogleFlightsSearchSpec({
      startUrl: 'https://www.google.com/travel/flights/',
      goal: 'Find the lowest fare from all eligible one-way flights for 1 adult from JFK to Heathrow on Jan. 22.',
    }, { now })).toMatchObject({
      origin: 'JFK',
      destination: 'Heathrow',
      tripType: 'one-way',
      departureDate: '2027-01-22',
    });

    expect(deriveGoogleFlightsSearchSpec({
      startUrl: 'https://www.google.com/travel/flights/',
      goal: 'Find flights from Chicago to London on 20 December and return on 23 December.',
    }, { now })).toMatchObject({
      origin: 'Chicago',
      destination: 'London',
      tripType: 'round-trip',
      departureDate: '2026-12-20',
      returnDate: '2026-12-23',
    });

    expect(deriveGoogleFlightsSearchSpec({
      startUrl: 'https://www.google.com/travel/flights/',
      goal: 'Search for a flight on December 19 and return on December 26 from Tel Aviv to Venice and Select First Class.',
    }, { now })).toMatchObject({
      origin: 'Tel Aviv',
      destination: 'Venice',
      tripType: 'round-trip',
      departureDate: '2026-12-19',
      returnDate: '2026-12-26',
    });
  });

  it('does not parse non-Google-Flights starts', () => {
    expect(deriveGoogleFlightsSearchSpec({
      startUrl: 'https://www.google.com/maps/',
      goal: 'Search for flights from Bangkok to Madrid on February 26, 2026.',
    })).toBeUndefined();
  });
});

describe('addGoogleFlightsDatesToTfs', () => {
  it('adds dates to route-only round-trip tfs payloads', () => {
    const routeOnly = 'CBwQARocagwIAxIIL20vMDNraG5yDAgDEggvbS8wZGx2MBocagwIAxIIL20vMGRsdjByDAgDEggvbS8wM2tobkABSAFwAYIBCwj___________8BmAEB';
    const dated = addGoogleFlightsDatesToTfs(routeOnly, '2027-03-28', '2027-04-04');
    const decoded = Buffer.from(dated || '', 'base64url').toString('utf8');

    expect(decoded).toContain('2027-03-28');
    expect(decoded).toContain('2027-04-04');
    expect(dated).toBe('CBwQAhooEgoyMDI3LTAzLTI4agwIAxIIL20vMDNraG5yDAgDEggvbS8wZGx2MBooEgoyMDI3LTA0LTA0agwIAxIIL20vMGRsdjByDAgDEggvbS8wM2tobkABSAFwAYIBCwj___________8BmAEB');
  });

  it('synthesizes a return leg when Google only encoded the outbound route', () => {
    const routeOnly = 'CBwQARodag0IAxIJL20vMDJfMjg2cgwIAxIIL20vMDRqcGwQAUgBcAGCAQsI____________AZgBAQ';
    const dated = addGoogleFlightsDatesToTfs(routeOnly, '2027-01-10', '2027-01-17');
    const decoded = Buffer.from(dated || '', 'base64url').toString('utf8');

    expect(decoded).toContain('2027-01-10');
    expect(decoded).toContain('2027-01-17');
    expect(decoded.indexOf('/m/02_286')).toBeGreaterThan(-1);
    expect(decoded.indexOf('/m/04jpl')).toBeGreaterThan(-1);
  });
});

describe('shouldAcceptRolledGoogleFlightsCompletion', () => {
  it('accepts verifier date-only rejections when rolled dates have concrete flight evidence', () => {
    const preflight = {
      profile: 'google-flights-search' as const,
      prepared: true,
      reason: 'Prepared Google Flights search.',
      spec: {
        origin: 'Bangkok',
        destination: 'Madrid',
        tripType: 'round-trip' as const,
        departureDate: '2027-02-26',
        returnDate: '2027-02-28',
        dateRoll: {
          originalDepartureDate: '2026-02-26',
          originalReturnDate: '2026-02-28',
          departureDate: '2027-02-26',
          returnDate: '2027-02-28',
        },
      },
      finalUrl: 'https://www.google.com/travel/flights/search?tfs=...',
    };

    expect(shouldAcceptRolledGoogleFlightsCompletion(
      preflight,
      {
        achieved: false,
        confidence: 0.5,
        evidence: [],
        missing: ['The current page uses 2027 dates but the requested task says 2026.'],
      },
      'Google Flights search results returned. Best cheapest round trip Bangkok to Madrid Feb 26 - 28, 2027: Turkish Airlines, 1 stop, $881 round trip.',
      {
        url: 'https://www.google.com/travel/flights/search?tfs=...',
        snapshot: 'Flight search Search results 11 results returned. Best Cheapest from $881 Top departing flights Bangkok Madrid Track prices departing 2027-02-26 and returning 2027-02-28.',
      },
    )).toBe(true);
  });

  it('does not accept rolled dates without concrete flight evidence', () => {
    expect(shouldAcceptRolledGoogleFlightsCompletion(
      {
        profile: 'google-flights-search',
        prepared: true,
        reason: 'Prepared Google Flights search.',
        spec: {
          origin: 'Bangkok',
          destination: 'Madrid',
          tripType: 'round-trip',
          departureDate: '2027-02-26',
          returnDate: '2027-02-28',
          dateRoll: {
            originalDepartureDate: '2026-02-26',
            originalReturnDate: '2026-02-28',
            departureDate: '2027-02-26',
            returnDate: '2027-02-28',
          },
        },
      },
      {
        achieved: false,
        confidence: 0.5,
        evidence: [],
        missing: ['The current page uses 2027 dates but the requested task says 2026.'],
      },
      'I could not find the flights.',
      {
        url: 'https://www.google.com/travel/flights/',
        snapshot: 'Google Flights homepage',
      },
    )).toBe(false);
  });
});
