// Request-level protections for a server that holds financial data and listens on localhost.
//  - Host check: stops DNS-rebinding (a malicious site whose DNS name is pointed at 127.0.0.1 reading your data).
//  - Origin / Fetch-Metadata check: stops other websites from making your browser change data (CSRF).
//  - Security headers, including a strict Content-Security-Policy (no inline scripts).
const loopback = (h) => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(String(h).toLowerCase());

function allowedHosts(port) {
  const extra = (process.env.PENNYSTEAD_ALLOWED_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  // On port 80 browsers send the host name without a port.
  const bare = +port === 80 ? ['localhost', '127.0.0.1', '[::1]'] : [];
  return new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, ...bare, ...extra]);
}

/** Returns null if the request is acceptable, otherwise { status, message }. */
function check(req, hosts) {
  const host = String(req.headers.host || '').toLowerCase();
  if (!hosts.has(host)) return { status: 421, message: 'Unexpected Host header. Pennystead only answers on localhost.' };
  const fetchSite = req.headers['sec-fetch-site'];
  const url = req.url || '';
  // The app's own requests are always same-origin. Another site, or another local app on a different port ("same-site" to a browser), is refused.
  if (url.startsWith('/api/') && fetchSite && !['same-origin', 'none'].includes(fetchSite)) return { status: 403, message: 'Cross-site requests are not allowed.' };
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.headers.origin;
    if (origin) {
      let o; try { o = new URL(origin); } catch { return { status: 403, message: 'Bad Origin header.' }; }
      if (!hosts.has(o.host.toLowerCase())) return { status: 403, message: 'Cross-origin request blocked.' };
    }
    if (fetchSite && !['same-origin', 'none'].includes(fetchSite)) return { status: 403, message: 'Cross-site request blocked.' };
  }
  return null;
}

const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";
function headers(extra = {}) {
  return {
    'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cache-Control': 'no-store', ...extra,
  };
}
module.exports = { check, headers, allowedHosts, loopback, CSP };
