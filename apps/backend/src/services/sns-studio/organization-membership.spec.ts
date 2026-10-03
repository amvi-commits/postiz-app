import { HttpException } from '@nestjs/common';
import { assertOrganizationMembership } from './organization-membership';

describe('assertOrganizationMembership', () => {
  it('allows an active organization membership', () => {
    expect(() =>
      assertOrganizationMembership(
        [{ id: 'local-test', users: [{ disabled: false }] }],
        'local-test',
      ),
    ).not.toThrow();
  });

  it('rejects an organization outside the user membership list', () => {
    try {
      assertOrganizationMembership(
        [{ id: 'local-test', users: [{ disabled: false }] }],
        'group',
      );
      throw new Error('Expected organization access to be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(403);
      expect((error as HttpException).getResponse()).toEqual({
        code: 'ORGANIZATION_ACCESS_DENIED',
      });
    }
  });

  it('rejects a disabled organization membership', () => {
    expect(() =>
      assertOrganizationMembership(
        [{ id: 'group', users: [{ disabled: true }] }],
        'group',
      ),
    ).toThrow(HttpException);
  });
});
