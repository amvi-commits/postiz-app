export type OrganizationSwitchFetcher = (
  path: string,
  options: RequestInit,
) => Promise<Pick<Response, 'ok'>>;

export const changeOrganizationAndReload = async (
  fetcher: OrganizationSwitchFetcher,
  organizationId: string,
  reload: () => void,
) => {
  const response = await fetcher('/user/change-org', {
    method: 'POST',
    body: JSON.stringify({ id: organizationId }),
  });

  if (!response.ok) {
    throw new Error('Organization change was rejected.');
  }

  reload();
};
