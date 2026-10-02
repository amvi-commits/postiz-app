import { changeOrganizationAndReload } from './organization.switch';

describe('changeOrganizationAndReload', () => {
  it('switches to a selected membership and reloads scoped account data', async () => {
    const fetcher = jest.fn().mockResolvedValue({ ok: true });
    const reload = jest.fn();

    await changeOrganizationAndReload(fetcher, 'group', reload);

    expect(fetcher).toHaveBeenCalledWith('/user/change-org', {
      method: 'POST',
      body: JSON.stringify({ id: 'group' }),
    });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload after the backend rejects an organization switch', async () => {
    const fetcher = jest.fn().mockResolvedValue({ ok: false });
    const reload = jest.fn();

    await expect(
      changeOrganizationAndReload(fetcher, 'group', reload),
    ).rejects.toThrow('Organization change was rejected.');
    expect(reload).not.toHaveBeenCalled();
  });
});
