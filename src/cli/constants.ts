import type { DriverConfig } from '../config.js';

export type RunMode = 'fast-explore' | 'full-evidence';
export const RUN_MODES: RunMode[] = ['fast-explore', 'full-evidence'];

export type DriverProfile = NonNullable<DriverConfig['profile']>;
export const DRIVER_PROFILES: DriverProfile[] = ['default', 'stealth', 'benchmark-webbench', 'benchmark-webbench-stealth', 'benchmark-webvoyager'];
