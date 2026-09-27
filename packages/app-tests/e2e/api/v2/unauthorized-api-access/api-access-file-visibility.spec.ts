import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { hashString } from '@documenso/lib/server-only/auth/hash';
import { createTeam } from '@documenso/lib/server-only/team/create-team';
import { alphaid } from '@documenso/lib/universal/id';
import { prisma } from '@documenso/prisma';
import { DocumentVisibility, TeamMemberRole, TemplateType } from '@documenso/prisma/client';
import { seedCompletedDocument } from '@documenso/prisma/seed/documents';
import { seedTeam, seedTeamMember } from '@documenso/prisma/seed/teams';
import { seedBlankTemplate } from '@documenso/prisma/seed/templates';
import { seedUser } from '@documenso/prisma/seed/users';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';

import { apiSignin } from '../../../fixtures/authentication';

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();

test.describe.configure({
  mode: 'parallel',
});

type SeededEnvelope = {
  id: string;
  envelopeItems: { id: string; documentDataId: string }[];
};

const viewUrl = (envelope: SeededEnvelope) =>
  `${WEBAPP_BASE_URL}/api/files/envelope/${envelope.id}/envelopeItem/${envelope.envelopeItems[0].id}`;

const downloadUrl = (envelope: SeededEnvelope, version: 'original' | 'signed') =>
  `${viewUrl(envelope)}/download/${version}`;

const itemPdfUrl = (envelope: SeededEnvelope, version: 'initial' | 'current') =>
  `${viewUrl(envelope)}/dataId/${envelope.envelopeItems[0].documentDataId}/${version}/item.pdf`;

const apiDownloadUrl = (envelope: SeededEnvelope) =>
  `${WEBAPP_BASE_URL}/api/v2/envelope/item/${envelope.envelopeItems[0].id}/download?version=signed`;

/**
 * Create an API token directly, bypassing the role check in `createApiToken`.
 *
 * This simulates a token that was minted while the user had permission, and which
 * survives a later downgrade to a lower team role (e.g. MEMBER).
 */
const seedApiTokenForUser = async ({ userId, teamId }: { userId: number; teamId: number }) => {
  const token = `api_${alphaid(16)}`;

  await prisma.apiToken.create({
    data: {
      name: `file-visibility-${alphaid(6)}`,
      token: hashString(token),
      expires: null,
      userId,
      teamId,
    },
  });

  return { token };
};

const apiDownload = (request: APIRequestContext, envelope: SeededEnvelope, token: string) => {
  return request.get(apiDownloadUrl(envelope), {
    headers: { Authorization: `Bearer ${token}` },
  });
};

/**
 * Seeds a team with an owner (ADMIN) and a MEMBER, plus a completed document owned
 * by the team owner with the given visibility.
 */
const seedTeamDocument = async (visibility: DocumentVisibility) => {
  const { team, owner } = await seedTeam();
  const member = await seedTeamMember({ teamId: team.id, role: TeamMemberRole.MEMBER });

  const document = await seedCompletedDocument(owner, team.id, ['recipient@test.documenso.com'], {
    createDocumentOptions: { visibility },
  });

  return { team, owner, member, document };
};

const expectAllSessionRoutesDenied = async (page: Page, envelope: SeededEnvelope) => {
  const viewRes = await page.request.get(viewUrl(envelope));
  expect(viewRes.status()).toBe(403);

  const originalRes = await page.request.get(downloadUrl(envelope, 'original'));
  expect(originalRes.status()).toBe(403);

  const signedRes = await page.request.get(downloadUrl(envelope, 'signed'));
  expect(signedRes.status()).toBe(403);

  const initialPdfRes = await page.request.get(itemPdfUrl(envelope, 'initial'));
  expect(initialPdfRes.status()).toBe(404);

  const currentPdfRes = await page.request.get(itemPdfUrl(envelope, 'current'));
  expect(currentPdfRes.status()).toBe(404);
};

test.describe('Envelope file routes - document visibility', () => {
  test('hides an ADMIN-only document from a team MEMBER on every session file route', async ({ page }) => {
    const { member, document } = await seedTeamDocument(DocumentVisibility.ADMIN);

    await apiSignin({ page, email: member.email });

    await expectAllSessionRoutesDenied(page, document);
  });

  test('hides a MANAGER_AND_ABOVE document from a team MEMBER on every session file route', async ({ page }) => {
    const { member, document } = await seedTeamDocument(DocumentVisibility.MANAGER_AND_ABOVE);

    await apiSignin({ page, email: member.email });

    await expectAllSessionRoutesDenied(page, document);
  });

  test('hides an ADMIN-only document from a team MEMBER on the API V2 item download', async ({ request }) => {
    const { team, member, document } = await seedTeamDocument(DocumentVisibility.ADMIN);

    const { token } = await seedApiTokenForUser({ userId: member.id, teamId: team.id });

    const res = await apiDownload(request, document, token);

    expect(res.ok()).toBeFalsy();
    expect(res.status()).toBe(404);
  });

  test('still allows a team MEMBER to download an EVERYONE document', async ({ page, request }) => {
    const { team, member, document } = await seedTeamDocument(DocumentVisibility.EVERYONE);

    await apiSignin({ page, email: member.email });

    const sessionRes = await page.request.get(downloadUrl(document, 'signed'));

    expect(sessionRes.ok()).toBeTruthy();
    expect(sessionRes.headers()['content-type']).toContain('application/pdf');

    const itemPdfRes = await page.request.get(itemPdfUrl(document, 'current'));

    expect(itemPdfRes.ok()).toBeTruthy();

    const { token } = await seedApiTokenForUser({ userId: member.id, teamId: team.id });

    const apiRes = await apiDownload(request, document, token);

    expect(apiRes.ok()).toBeTruthy();
    expect(apiRes.headers()['content-type']).toContain('application/pdf');
  });

  test('still allows a team ADMIN to download an ADMIN-only document', async ({ page }) => {
    const { team, document } = await seedTeamDocument(DocumentVisibility.ADMIN);
    const admin = await seedTeamMember({ teamId: team.id, role: TeamMemberRole.ADMIN });

    await apiSignin({ page, email: admin.email });

    const res = await page.request.get(downloadUrl(document, 'signed'));

    expect(res.ok()).toBeTruthy();
    expect(res.headers()['content-type']).toContain('application/pdf');
  });
});

test.describe('Envelope file routes - organisation template visibility', () => {
  /**
   * One organisation with two teams. The ORGANISATION template lives on team A and
   * the caller is only a MEMBER of team B, so access relies on the organisation fallback.
   */
  const seedOrgTemplate = async (visibility: DocumentVisibility) => {
    const { user: ownerA, organisation, team: teamA } = await seedUser();

    const teamBUrl = `team-b-${alphaid(10)}`;

    await createTeam({
      userId: ownerA.id,
      teamName: `Team B ${teamBUrl}`,
      teamUrl: teamBUrl,
      organisationId: organisation.id,
      inheritMembers: false,
    });

    const teamB = await prisma.team.findFirstOrThrow({
      where: { url: teamBUrl },
    });

    const memberB = await seedTeamMember({ teamId: teamB.id, role: TeamMemberRole.MEMBER });

    const template = await seedBlankTemplate(ownerA, teamA.id, {
      createTemplateOptions: {
        templateType: TemplateType.ORGANISATION,
        visibility,
      },
    });

    return { memberB, template };
  };

  test('hides an ADMIN-only organisation template from a MEMBER of another team', async ({ page }) => {
    const { memberB, template } = await seedOrgTemplate(DocumentVisibility.ADMIN);

    await apiSignin({ page, email: memberB.email });

    const res = await page.request.get(downloadUrl(template, 'original'));
    expect(res.status()).toBe(403);

    const itemPdfRes = await page.request.get(itemPdfUrl(template, 'initial'));
    expect(itemPdfRes.status()).toBe(404);
  });

  test('still allows a MEMBER of another team to view an EVERYONE organisation template', async ({ page }) => {
    const { memberB, template } = await seedOrgTemplate(DocumentVisibility.EVERYONE);

    await apiSignin({ page, email: memberB.email });

    const res = await page.request.get(downloadUrl(template, 'original'));

    expect(res.ok()).toBeTruthy();
    expect(res.headers()['content-type']).toContain('application/pdf');
  });
});
