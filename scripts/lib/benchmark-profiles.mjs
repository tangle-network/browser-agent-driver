export const BENCHMARK_PROFILES = {
  default: {
    id: 'default',
    driverProfile: 'default',
    description: 'Balanced defaults for ad-hoc tracks and internal staging runs.',
  },
  webbench: {
    id: 'webbench',
    driverProfile: 'benchmark-webbench',
    description: 'Fast, low-noise profile for broad WebBench-style sweeps.',
  },
  'webbench-stealth': {
    id: 'webbench-stealth',
    driverProfile: 'benchmark-webbench-stealth',
    description: 'Reach-oriented WebBench profile for anti-bot-prone public-web tasks.',
  },
  webvoyager: {
    id: 'webvoyager',
    driverProfile: 'benchmark-webvoyager',
    description: 'Higher-evidence profile for longer multi-step public-web tasks.',
  },
};

export function resolveBenchmarkProfile(profileId = 'default') {
  const resolved = BENCHMARK_PROFILES[profileId];
  if (!resolved) {
    const valid = Object.keys(BENCHMARK_PROFILES).join(', ');
    throw new Error(`Unknown benchmark profile "${profileId}". Valid profiles: ${valid}`);
  }
  return resolved;
}
