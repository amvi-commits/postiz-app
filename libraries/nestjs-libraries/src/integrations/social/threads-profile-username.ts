const USERNAME = /^[a-z0-9._]{1,30}$/i;
const THREADS_HOSTS = [
  'threads.com',
  'www.threads.com',
  'threads.net',
  'www.threads.net',
];

export function threadsProfileUsername(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > 512) return null;
  const value = input.trim().replace(/^@/, '');
  if (USERNAME.test(value)) return value;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      !THREADS_HOSTS.includes(url.hostname) ||
      url.port ||
      url.username ||
      url.password
    )
      return null;
    return url.pathname.match(/^\/@([a-z0-9._]{1,30})\/?$/i)?.[1] || null;
  } catch {
    return null;
  }
}
