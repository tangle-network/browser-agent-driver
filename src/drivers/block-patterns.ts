/**
 * Resource blocking patterns for analytics, tracking, ads, images, and media.
 * Used by PlaywrightDriver.setupResourceBlocking() to abort unnecessary requests.
 */

/** Analytics and tracking domain patterns (matched via URL.includes()) */
export const ANALYTICS_PATTERNS: string[] = [
  // Google
  'google-analytics.com',
  'googletagmanager.com',
  'googlesyndication.com',
  'googleadservices.com',
  'google.com/pagead',
  'doubleclick.net',
  'googleads.g.doubleclick.net',
  // Facebook / Meta
  'facebook.com/tr',
  'connect.facebook.net',
  'facebook.net/signals',
  'fbcdn.net/signals',
  // Analytics platforms
  'segment.io',
  'segment.com',
  'cdn.segment.com',
  'mixpanel.com',
  'amplitude.com',
  'api.amplitude.com',
  'cdn.amplitude.com',
  'heap.io',
  'heapanalytics.com',
  'fullstory.com',
  'rs.fullstory.com',
  'hotjar.com',
  'static.hotjar.com',
  'script.hotjar.com',
  'clarity.ms',
  'smartlook.com',
  'mouseflow.com',
  'logrocket.com',
  'cdn.logrocket.io',
  'posthog.com',
  'app.posthog.com',
  'plausible.io',
  'stats.wp.com',
  // Ad networks
  'adroll.com',
  'adsrvr.org',
  'criteo.com',
  'static.criteo.net',
  'taboola.com',
  'outbrain.com',
  'amazon-adsystem.com',
  'ads-twitter.com',
  'ads.linkedin.com',
  'snap.licdn.com',
  'px.ads.linkedin.com',
  // Tag managers & data
  'cdn.rudderlabs.com',
  'cdn.mxpnl.com',
  'js-agent.newrelic.com',
  'bam.nr-data.net',
  'browser.sentry-cdn.com',
  'sentry.io/api',
  'rum.datadog.com',
  'datadoghq.com',
  'bugsnag.com',
  'rollbar.com',
  // Chat/support widgets
  'widget.intercom.io',
  'js.intercomcdn.com',
  'embed.tawk.to',
  'static.zdassets.com',
  'cdn.jsdelivr.net/npm/@drift',
  // Marketing & tracking pixels
  'bat.bing.com',
  'ct.pinterest.com',
  'analytics.tiktok.com',
  'snap.licdn.com',
  'tr.snapchat.com',
  'sc-static.net/scevent',
  // Survey/feedback
  'survicate.com',
  'qualtrics.com',
  'usabilla.com',
  // A/B testing
  'optimizely.com',
  'cdn.optimizely.com',
  'cdn-pci.optimizely.com',
  'launchdarkly.com',
  'app.launchdarkly.com',
  'split.io',
  'cdn.split.io',
  'vwo.com',
  'd5nxst8fruw4z.cloudfront.net', // VWO
  // Cookie consent (often blocks interaction)
  'cookiebot.com',
  'cdn.cookielaw.org',
  'consentmanager.net',
];

/** Image file extension patterns */
export const IMAGE_PATTERNS: string[] = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.ico',
  '.bmp',
  '.avif',
];

/** Media file extension patterns */
export const MEDIA_PATTERNS: string[] = [
  '.mp4',
  '.webm',
  '.ogg',
  '.mp3',
  '.wav',
  '.flac',
  '.m4a',
  '.avi',
  '.mov',
];
