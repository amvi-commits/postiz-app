import { chooseShuffleBagItem } from './shuffle-bag';

describe('chooseShuffleBagItem', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('uses every active item once per cycle, then starts another cycle', () => {
    const history: Array<{ itemId: string; cycle: number }> = [];
    for (const random of [() => 0, () => 0, () => 0]) {
      const result = chooseShuffleBagItem(items, history, random)!;
      expect(history.some((row) => row.cycle === result.cycle && row.itemId === result.item.id)).toBe(false);
      history.push({ itemId: result.item.id, cycle: result.cycle });
    }
    expect(new Set(history.filter((row) => row.cycle === 1).map((row) => row.itemId))).toEqual(new Set(['a', 'b', 'c']));
    expect(chooseShuffleBagItem(items, history, () => 0)).toEqual({ item: items[0], cycle: 2 });
  });

  it('returns null for an empty pool', () => {
    expect(chooseShuffleBagItem([], [])).toBeNull();
  });

  it('keeps account histories independent by accepting the caller history only', () => {
    expect(chooseShuffleBagItem(items, [{ itemId: 'a', cycle: 1 }], () => 0)?.item.id).toBe('b');
    expect(chooseShuffleBagItem(items, [], () => 0)?.item.id).toBe('a');
  });
});
