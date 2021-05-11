// eslint-disable-next-line no-restricted-imports
import { format as formatUrl, parse as parseUrlLegacy } from 'url';
import urlJoin from 'url-join';

export { formatUrl, parseUrlLegacy };

export function ensureTrailingSlash(url: string): string {
  return url.replace(/\/?$/, '/');
}

export function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export function resolveBaseUrl(baseUrl: string, input: string | URL): string {
  const inputString = input.toString();

  let host: string | undefined;
  let pathname: string;
  try {
    ({ host, pathname } = new URL(inputString));
  } catch (e) {
    pathname = inputString;
  }

  return host ? inputString : urlJoin(baseUrl, pathname || '');
}

export function getQueryString(params: Record<string, any>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) {
      for (const item of v) {
        usp.append(k, item.toString());
      }
    } else {
      usp.append(k, v.toString());
    }
  }
  const res = usp.toString();
  return res;
}

export function validateUrl(url?: string, httpOnly = true): boolean {
  if (!url) {
    return false;
  }
  try {
    const { protocol } = new URL(url);
    return httpOnly ? !!protocol.startsWith('http') : !!protocol;
  } catch (err) {
    return false;
  }
}

export function parseUrl(url: string, base?: string | URL): URL | null {
  try {
    return new URL(url, base);
  } catch (err) {
    return null;
  }
}

/**
 * works like resolve from `url` module
 * https://nodejs.org/api/url.html#url_url_resolve_from_to
 *
 * TODO: This throws for invalid urls, maybe catch and return null?
 */
export function resolveUrl(from: string, to: string): string {
  const resolvedUrl = new URL(to, new URL(from, 'resolve://'));
  if (resolvedUrl.protocol === 'resolve:') {
    // `from` is a relative URL.
    const { pathname, search, hash } = resolvedUrl;
    return pathname + search + hash;
  }
  return resolvedUrl.href;
}
