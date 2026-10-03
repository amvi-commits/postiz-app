import { HttpException, HttpStatus } from '@nestjs/common';

type OrganizationMembership = {
  id: string;
  users?: Array<{ disabled: boolean }>;
};

export const assertOrganizationMembership = (
  organizations: OrganizationMembership[],
  requestedOrganizationId: unknown,
) => {
  const isAuthorized =
    typeof requestedOrganizationId === 'string' &&
    organizations.some(
      (organization) =>
        organization.id === requestedOrganizationId &&
        organization.users?.some((membership) => !membership.disabled),
    );

  if (!isAuthorized) {
    throw new HttpException(
      { code: 'ORGANIZATION_ACCESS_DENIED' },
      HttpStatus.FORBIDDEN,
    );
  }
};
