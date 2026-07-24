export const FLYREQ_TASK_TOKEN_HEADER = 'X-Flyreq-Task-Token';

const FLYREQ_IMAGE_PATH_PREFIX = '/api/flyreq/images/';

function getCurrentOrigin(): string {
  if (typeof window !== 'undefined' && window.location?.origin) return window.location.origin;
  if (typeof globalThis.location !== 'undefined' && globalThis.location?.origin) {
    return globalThis.location.origin;
  }
  return 'http://localhost';
}

function withHeader(headers: HeadersInit | undefined, name: string, value: string): HeadersInit {
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    const next = new Headers(headers);
    next.set(name, value);
    return next;
  }
  if (Array.isArray(headers)) {
    return [
      ...headers.filter(([key]) => key.toLowerCase() !== name.toLowerCase()),
      [name, value],
    ];
  }
  return { ...(headers || {}), [name]: value };
}

export function buildFlyreqImageFetchRequest(
  url: string,
  readToken?: string,
  init: RequestInit = {},
): { url: string; init: RequestInit } {
  const token = String(readToken || '').trim();
  if (!token) return { url, init };

  try {
    const origin = getCurrentOrigin();
    const current = new URL(origin);
    const parsed = new URL(url, origin);
    if (parsed.origin !== current.origin || !parsed.pathname.startsWith(FLYREQ_IMAGE_PATH_PREFIX)) {
      return { url, init };
    }

    const sanitizedUrl = stripFlyreqImageReadTokenFromUrl(url);
    return {
      url: sanitizedUrl,
      init: {
        ...init,
        headers: withHeader(init.headers, FLYREQ_TASK_TOKEN_HEADER, token),
      },
    };
  } catch {
    return { url, init };
  }
}

export function stripFlyreqImageReadTokenFromUrl(url: string): string {
  try {
    const origin = getCurrentOrigin();
    const current = new URL(origin);
    const parsed = new URL(url, origin);
    if (parsed.origin !== current.origin || !parsed.pathname.startsWith(FLYREQ_IMAGE_PATH_PREFIX)) {
      return url;
    }

    parsed.searchParams.delete('token');
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return url;
  }
}

export function stripFlyreqImageReadTokenFromRef(ref: string): string {
  if (ref.startsWith('URL:')) {
    return `URL:${stripFlyreqImageReadTokenFromUrl(ref.slice(4))}`;
  }
  if (ref.startsWith('MULTI_URL:')) {
    return `MULTI_URL:${ref.slice(10).split('|||').map(stripFlyreqImageReadTokenFromUrl).join('|||')}`;
  }
  return ref;
}
