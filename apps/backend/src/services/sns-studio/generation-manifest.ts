import { createHash } from 'crypto';
export function generationInputHash(value: unknown): string {
  const sort = (item: any): any => Array.isArray(item) ? item.map(sort) : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, sort(item[key])])) : item;
  return createHash('sha256').update(JSON.stringify(sort(value))).digest('hex');
}
