import type { EnterpriseUser, UpnMatchMethod } from '../types/index.js';

export interface ScimUser {
  externalId?: string | null;
  userName?: string | null;
  displayName?: string | null;
}

export interface EntraUser {
  id: string;
  userPrincipalName: string;
  displayName: string;
  amCompanyCode?: string;
  amBuCode?: string;
  amSegmentCode?: string;
  smtp?: string;
}

export interface UpnResolution {
  matchedByExternalId: number;
  matchedByDisplayName: number;
  ambiguous: number;
  unresolved: number;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function addToIndex<T>(index: Map<string, T[]>, key: string | null | undefined, value: T): void {
  if (!key?.trim()) return;
  const normalizedKey = normalize(key);
  const values = index.get(normalizedKey) ?? [];
  values.push(value);
  index.set(normalizedKey, values);
}

function assignUpn(user: EnterpriseUser, entraUser: EntraUser, method: UpnMatchMethod): void {
  user.userPrincipalName = entraUser.userPrincipalName.trim();
  user.amCompanyCode = entraUser.amCompanyCode?.trim() || undefined;
  user.amBuCode = entraUser.amBuCode?.trim() || undefined;
  user.amSegmentCode = entraUser.amSegmentCode?.trim() || undefined;
  user.smtp = entraUser.smtp?.trim() || undefined;
  user.upnMatchMethod = method;
}

function isStrictUpnPrefix(projectedUsername: string, userPrincipalName: string): boolean {
  const projected = normalize(projectedUsername);
  const upn = normalize(userPrincipalName);
  return upn.length > projected.length && upn.startsWith(projected);
}

function deduplicateScimMatches(matches: ScimUser[]): ScimUser[] {
  const uniqueMatches = new Map<string, ScimUser>();

  for (const match of matches) {
    const externalId = match.externalId?.trim();
    const displayName = match.displayName?.trim();
    const key = externalId
      ? `external-id:${normalize(externalId)}`
      : `display-name:${displayName ? normalize(displayName) : ''}`;
    uniqueMatches.set(key, match);
  }

  return [...uniqueMatches.values()];
}

/** Resolve GitHub users to authoritative Entra UPNs without using email as a proxy. */
export function resolveUserPrincipalNames(
  users: EnterpriseUser[],
  scimUsers: ScimUser[],
  entraUsers: EntraUser[]
): UpnResolution {
  const scimByUsername = new Map<string, ScimUser[]>();
  const entraById = new Map<string, EntraUser[]>();
  const entraByDisplayName = new Map<string, EntraUser[]>();

  for (const scimUser of scimUsers) {
    addToIndex(scimByUsername, scimUser.userName, scimUser);
  }
  for (const entraUser of entraUsers) {
    addToIndex(entraById, entraUser.id, entraUser);
    addToIndex(entraByDisplayName, entraUser.displayName, entraUser);
  }

  const resolution: UpnResolution = {
    matchedByExternalId: 0,
    matchedByDisplayName: 0,
    ambiguous: 0,
    unresolved: 0,
  };

  for (const user of users) {
    const projectedUsername = user.externalIdentity?.scimUsername?.trim();
    if (!projectedUsername) continue;

    const scimMatches = deduplicateScimMatches(
      scimByUsername.get(normalize(projectedUsername)) ?? []
    );
    if (scimMatches.length > 1) {
      resolution.ambiguous++;
      continue;
    }

    const scimUser = scimMatches[0];
    const scimExternalId = scimUser?.externalId?.trim();
    if (scimExternalId) {
      user.externalIdentity = {
        ...user.externalIdentity,
        externalId: scimExternalId,
      };
    }

    if (scimExternalId) {
      const idMatches = entraById.get(normalize(scimExternalId)) ?? [];
      if (idMatches.length === 1) {
        assignUpn(user, idMatches[0], 'external_id');
        resolution.matchedByExternalId++;
        continue;
      }
      if (idMatches.length > 1) {
        resolution.ambiguous++;
        continue;
      }
    }

    const displayNames = new Set(
      [scimUser?.displayName, user.name]
        .filter((value): value is string => Boolean(value?.trim()))
        .map(normalize)
    );
    const fallbackCandidates = new Map<string, EntraUser>();

    for (const displayName of displayNames) {
      for (const candidate of entraByDisplayName.get(displayName) ?? []) {
        if (isStrictUpnPrefix(projectedUsername, candidate.userPrincipalName)) {
          fallbackCandidates.set(normalize(candidate.id), candidate);
        }
      }
    }

    const fallbackCandidate = fallbackCandidates.values().next().value;
    if (fallbackCandidates.size === 1 && fallbackCandidate) {
      assignUpn(user, fallbackCandidate, 'display_name');
      resolution.matchedByDisplayName++;
    } else if (fallbackCandidates.size > 1) {
      resolution.ambiguous++;
    } else {
      resolution.unresolved++;
    }
  }

  return resolution;
}