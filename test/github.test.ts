import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fetchEnterpriseScimUsers,
  fetchOrgScimUsers,
} from '../src/api/github.js';
import { parseEntraUsers } from '../src/identity/entra-extract.js';
import { resolveUserPrincipalNames } from '../src/identity/upn.js';
import type { EnterpriseUser, GitHubConfig } from '../src/types/index.js';

function enterpriseUser(
  name: string,
  scimUsername: string
): EnterpriseUser {
  return {
    login: name.toLowerCase().replaceAll(' ', '-'),
    name,
    email: '',
    organizations: [],
    externalIdentity: { scimUsername },
    copilotLicense: { assigned: false, pendingCancellation: false },
  };
}

test('parses PowerShell and Microsoft Graph Entra extract shapes', () => {
  const result = parseEntraUsers({
    value: [
      {
        Id: 'entra-1',
        UserPrincipalName: 'first@arcelormittal.com',
        DisplayName: 'First User',
      },
      {
        id: 'entra-2',
        userPrincipalName: 'second@arcelormittal.com',
        displayName: 'Second User',
      },
      { id: 'missing-upn', displayName: 'Skipped User' },
    ],
  });

  assert.deepEqual(result, {
    users: [
      {
        id: 'entra-1',
        userPrincipalName: 'first@arcelormittal.com',
        displayName: 'First User',
      },
      {
        id: 'entra-2',
        userPrincipalName: 'second@arcelormittal.com',
        displayName: 'Second User',
      },
    ],
    skipped: 1,
  });
});

test('resolves an authoritative Entra UPN through the SCIM external ID', () => {
  const user = enterpriseUser('Different GitHub Name', 'person@arcelormittal.c');

  const result = resolveUserPrincipalNames(
    [user],
    [{
      userName: 'person@arcelormittal.c',
      externalId: 'ENTRA-OBJECT-ID',
      displayName: 'Different SCIM Name',
    }],
    [{
      id: 'entra-object-id',
      userPrincipalName: 'person@arcelormittal.com',
      displayName: 'Authoritative Entra Name',
    }]
  );

  assert.equal(user.userPrincipalName, 'person@arcelormittal.com');
  assert.equal(user.upnMatchMethod, 'external_id');
  assert.deepEqual(result, {
    matchedByExternalId: 1,
    matchedByDisplayName: 0,
    ambiguous: 0,
    unresolved: 0,
  });
});

test('deduplicates the same SCIM identity returned by multiple organizations', () => {
  const user = enterpriseUser('Repeated User', 'repeated@arcelormittal.c');
  const repeatedScimUser = {
    userName: 'repeated@arcelormittal.c',
    externalId: 'entra-1',
    displayName: 'Repeated User',
  };

  const result = resolveUserPrincipalNames(
    [user],
    [repeatedScimUser, { ...repeatedScimUser }],
    [{
      id: 'entra-1',
      userPrincipalName: 'repeated@arcelormittal.com',
      displayName: 'Repeated User',
    }]
  );

  assert.equal(user.userPrincipalName, 'repeated@arcelormittal.com');
  assert.equal(result.matchedByExternalId, 1);
  assert.equal(result.ambiguous, 0);
});

test('uses display name after an unmatched SCIM external ID', () => {
  const user = enterpriseUser('Fallback User', 'fallback@arcelormittal.c');

  const result = resolveUserPrincipalNames(
    [user],
    [{
      userName: 'fallback@arcelormittal.c',
      externalId: 'missing-from-entra',
      displayName: 'Fallback User',
    }],
    [{
      id: 'entra-1',
      userPrincipalName: 'fallback@arcelormittal.com',
      displayName: 'Fallback User',
    }]
  );

  assert.equal(user.userPrincipalName, 'fallback@arcelormittal.com');
  assert.equal(user.upnMatchMethod, 'display_name');
  assert.equal(result.matchedByDisplayName, 1);
});

test('leaves conflicting SCIM external IDs ambiguous', () => {
  const user = enterpriseUser('Conflicted User', 'conflicted@arcelormittal.c');

  const result = resolveUserPrincipalNames(
    [user],
    [
      { userName: 'conflicted@arcelormittal.c', externalId: 'entra-1' },
      { userName: 'conflicted@arcelormittal.c', externalId: 'entra-2' },
    ],
    [
      {
        id: 'entra-1',
        userPrincipalName: 'conflicted@arcelormittal.com',
        displayName: 'Conflicted User',
      },
      {
        id: 'entra-2',
        userPrincipalName: 'conflicted@arcelormittal.org',
        displayName: 'Conflicted User',
      },
    ]
  );

  assert.equal(user.userPrincipalName, undefined);
  assert.equal(result.ambiguous, 1);
});

test('uses display name only for a unique candidate consistent with the truncated UPN', () => {
  const user = enterpriseUser('Mottet, Emmanuel', 'EMMANUEL.MOTTET@arcelormittal.c');

  const result = resolveUserPrincipalNames(
    [user],
    [{ userName: 'EMMANUEL.MOTTET@arcelormittal.c', displayName: 'Mottet, Emmanuel' }],
    [{
      id: 'entra-1',
      userPrincipalName: 'EMMANUEL.MOTTET@arcelormittal.com',
      displayName: 'Mottet, Emmanuel',
    }]
  );

  assert.equal(user.userPrincipalName, 'EMMANUEL.MOTTET@arcelormittal.com');
  assert.equal(user.upnMatchMethod, 'display_name');
  assert.equal(result.matchedByDisplayName, 1);
});

test('leaves display-name fallback unresolved when the UPN does not share the prefix', () => {
  const user = enterpriseUser('Common Name', 'other.person@arcelormittal.c');

  const result = resolveUserPrincipalNames(
    [user],
    [{ userName: 'other.person@arcelormittal.c', displayName: 'Common Name' }],
    [{
      id: 'entra-1',
      userPrincipalName: 'different.person@arcelormittal.com',
      displayName: 'Common Name',
    }]
  );

  assert.equal(user.userPrincipalName, undefined);
  assert.equal(result.unresolved, 1);
});

test('leaves display-name fallback ambiguous when multiple Entra UPNs share the prefix', () => {
  const user = enterpriseUser('Common Name', 'person@arcelormittal.');

  const result = resolveUserPrincipalNames(
    [user],
    [{ userName: 'person@arcelormittal.', displayName: 'Common Name' }],
    [
      {
        id: 'entra-1',
        userPrincipalName: 'person@arcelormittal.com',
        displayName: 'Common Name',
      },
      {
        id: 'entra-2',
        userPrincipalName: 'person@arcelormittal.org',
        displayName: 'Common Name',
      },
    ]
  );

  assert.equal(user.userPrincipalName, undefined);
  assert.equal(result.ambiguous, 1);
});

test('fetches paginated SCIM records with the dedicated token', async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];

  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    requestedUrls.push(url);

    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), 'Bearer scim-token');
    assert.equal(headers.get('user-agent'), 'github4flateurope/1.0.0');

    if (url.includes('/enterprises/flat%20europe/Users') && url.includes('startIndex=1')) {
      return new Response(JSON.stringify({
        totalResults: 3,
        Resources: [
          { externalId: 'entra-1', userName: 'first@example.c', displayName: 'First User' },
          { externalId: 'entra-2', userName: 'second@example.com', displayName: 'Second User' },
        ],
      }), { status: 200 });
    }
    if (url.includes('/enterprises/flat%20europe/Users') && url.includes('startIndex=3')) {
      return new Response(JSON.stringify({
        totalResults: 3,
        Resources: [{ externalId: 'entra-3', userName: 'third@example.com' }],
      }), { status: 200 });
    }
    if (url.includes('/organizations/flat%20org/Users')) {
      return new Response(JSON.stringify({
        totalResults: 1,
        Resources: [{ externalId: 'entra-4', userName: 'org@example.com' }],
      }), { status: 200 });
    }

    return new Response('Unexpected URL', { status: 500 });
  };

  const cfg: GitHubConfig = {
    apiBaseUrl: 'https://api.github.com',
    enterpriseSlug: 'flat europe',
    graphqlUrl: 'https://api.github.com/graphql',
    token: 'github-token',
    scimToken: 'scim-token',
  };

  try {
    assert.deepEqual(await fetchEnterpriseScimUsers(cfg), [
      { externalId: 'entra-1', userName: 'first@example.c', displayName: 'First User' },
      { externalId: 'entra-2', userName: 'second@example.com', displayName: 'Second User' },
      { externalId: 'entra-3', userName: 'third@example.com', displayName: undefined },
    ]);
    assert.deepEqual(await fetchOrgScimUsers(cfg, 'flat org'), [
      { externalId: 'entra-4', userName: 'org@example.com', displayName: undefined },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(requestedUrls, [
    'https://api.github.com/scim/v2/enterprises/flat%20europe/Users?startIndex=1&count=100',
    'https://api.github.com/scim/v2/enterprises/flat%20europe/Users?startIndex=3&count=100',
    'https://api.github.com/scim/v2/organizations/flat%20org/Users?startIndex=1&count=100',
  ]);
});
