export type ShuffleBagUsage = { itemId: string; cycle: number };

export function chooseShuffleBagItem<T extends { id: string }>(
  items: T[],
  history: ShuffleBagUsage[],
  random: () => number = Math.random
): { item: T; cycle: number } | null {
  if (!items.length) return null;
  const cycle = history.length
    ? Math.max(...history.map((entry) => entry.cycle))
    : 1;
  const used = new Set(
    history.filter((entry) => entry.cycle === cycle).map((entry) => entry.itemId)
  );
  let nextCycle = cycle;
  let available = items.filter((item) => !used.has(item.id));
  if (!available.length) {
    nextCycle += 1;
    available = items;
  }
  const index = Math.min(
    available.length - 1,
    Math.max(0, Math.floor(random() * available.length))
  );
  return { item: available[index], cycle: nextCycle };
}
