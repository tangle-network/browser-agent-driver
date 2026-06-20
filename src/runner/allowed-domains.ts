/**
 * Allowed-domain helpers — registrable-root derivation used for first-party
 * subdomain tolerance when enforcing a scenario's allowedDomains boundary.
 */

/**
 * Reduce a hostname to its registrable root (last two labels) so that
 * `news.example.com` and `example.com` compare equal. Hosts with two or
 * fewer labels are returned unchanged.
 */
export function domainRoot(host: string): string {
  const parts = host.split('.').filter(Boolean);
  return parts.length <= 2 ? host : parts.slice(-2).join('.');
}
