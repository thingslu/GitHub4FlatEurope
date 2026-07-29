import type {
  GitHubConfig,
  Organization,
  EnterpriseUser,
  ExternalIdentity,
  CopilotLicense,
} from '../types/index.js';
import type { ScimUser } from '../identity/upn.js';
import { ProxyAgent, setGlobalDispatcher } from 'undici';

const proxyUrl = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
if (proxyUrl) {
  // Ensure Node fetch uses enterprise proxy when direct egress is blocked.
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
}

// ─── Low-level helpers ────────────────────────────────────────────────────────

/** Execute a GraphQL query and return `data`. Throws on HTTP or GraphQL errors. */
async function gql<T = unknown>(
  url: string,
  token: string,
  query: string,
  variables: Record<string, unknown> = {}
): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Github-Next-Global-ID': '1', // opt-in to new global node IDs
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GraphQL HTTP ${res.status} ${res.statusText}: ${body}`);
  }

  const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors?.length) {
    throw new Error(json.errors.map(e => e.message).join(' | '));
  }
  return json.data as T;
}

/** Execute a REST GET and return parsed JSON. Returns [] on 404 (e.g. no Copilot billing). */
async function restGet<T = unknown>(url: string, token: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'github4flateurope/1.0.0',
    },
  });

  if (res.status === 404) return [] as unknown as T;
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`REST HTTP ${res.status} ${res.statusText}: ${body}`);
  }
  return res.json() as Promise<T>;
}

// ─── Pagination helper ────────────────────────────────────────────────────────

interface GraphQLPage<TNode> {
  nodes: TNode[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

async function* paginate<TNode>(
  graphqlUrl: string,
  token: string,
  query: string,
  variables: Record<string, unknown>,
  getPage: (data: unknown) => GraphQLPage<TNode>
): AsyncGenerator<TNode[]> {
  let after: string | null = null;

  do {
    const data = await gql(graphqlUrl, token, query, { ...variables, after });
    const page = getPage(data);
    yield page.nodes;
    if (!page.pageInfo.hasNextPage) break;
    after = page.pageInfo.endCursor;
  } while (true);
}

// ─── 1. Enterprise Organisations ─────────────────────────────────────────────

const ORGS_QUERY = /* graphql */ `
  query EnterpriseOrgs($slug: String!, $after: String) {
    enterprise(slug: $slug) {
      organizations(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { login name }
      }
    }
  }
`;

type OrgsData = { enterprise: { organizations: GraphQLPage<Organization> } | null };

export async function fetchEnterpriseOrgs(cfg: GitHubConfig): Promise<Organization[]> {
  const orgs: Organization[] = [];
  for await (const page of paginate<Organization>(
    cfg.graphqlUrl,
    cfg.token,
    ORGS_QUERY,
    { slug: cfg.enterpriseSlug },
    d => {
      const enterprise = (d as OrgsData).enterprise;
      if (!enterprise) {
        throw new Error(
          `Enterprise '${cfg.enterpriseSlug}' not found or not accessible with this token.`
        );
      }
      return enterprise.organizations;
    }
  )) {
    orgs.push(...page);
  }
  return orgs;
}

// ─── 2. Enterprise Members ────────────────────────────────────────────────────

const MEMBERS_QUERY = /* graphql */ `
  query EnterpriseMembers($slug: String!, $after: String) {
    enterprise(slug: $slug) {
      members(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          ... on EnterpriseUserAccount {
            login
            name
            organizations(first: 100) { nodes { login } }
          }
        }
      }
    }
  }
`;

interface RawMember {
  login?: string;
  name?: string;
  organizations?: { nodes: Array<{ login: string }> };
}

type MembersData = { enterprise: { members: GraphQLPage<RawMember> } | null };

export async function fetchEnterpriseMembers(cfg: GitHubConfig): Promise<EnterpriseUser[]> {
  const users: EnterpriseUser[] = [];

  for await (const page of paginate<RawMember>(
    cfg.graphqlUrl,
    cfg.token,
    MEMBERS_QUERY,
    { slug: cfg.enterpriseSlug },
    d => {
      const enterprise = (d as MembersData).enterprise;
      if (!enterprise) {
        throw new Error(
          `Enterprise '${cfg.enterpriseSlug}' not found or not accessible with this token.`
        );
      }
      return enterprise.members;
    }
  )) {
    for (const m of page) {
      if (!m.login) continue;
      users.push({
        login: m.login,
        name: m.name ?? '',
        organizations: m.organizations?.nodes.map(o => o.login) ?? [],
        copilotLicense: { assigned: false, pendingCancellation: false },
      });
    }
  }

  return users;
}

// ─── 3. External Identities (SAML / SCIM) ────────────────────────────────────

const EXT_ID_QUERY = /* graphql */ `
  query OrgExternalIdentities($org: String!, $after: String) {
    organization(login: $org) {
      samlIdentityProvider {
        externalIdentities(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            scimIdentity  { username }
            user           { login }
          }
        }
      }
    }
  }
`;

interface RawExtId {
  scimIdentity?: { username?: string };
  user?: { login: string };
}

function preferLonger(a?: string, b?: string): string | undefined {
  if (a && b) return b.length > a.length ? b : a;
  return b ?? a;
}

function mergeExternalIdentity(
  current: ExternalIdentity | undefined,
  next: ExternalIdentity
): ExternalIdentity {
  if (!current) return next;

  return {
    scimUsername: preferLonger(current.scimUsername, next.scimUsername),
  };
}

type ExtIdData = {
  organization?: {
    samlIdentityProvider?: {
      externalIdentities?: GraphQLPage<RawExtId>;
    };
  };
};

type EnterpriseExtIdData = {
  enterprise: {
    ownerInfo?: {
      samlIdentityProvider?: {
        externalIdentities?: GraphQLPage<RawExtId>;
      };
    };
  } | null;
};

const ENTERPRISE_EXT_ID_QUERY = /* graphql */ `
  query EnterpriseExternalIdentities($slug: String!, $after: String) {
    enterprise(slug: $slug) {
      ownerInfo {
        samlIdentityProvider {
          externalIdentities(first: 100, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes {
              scimIdentity  { username }
              user           { login }
            }
          }
        }
      }
    }
  }
`;

/** Returns a map of GitHub login → ExternalIdentity from enterprise-level SAML identity provider. */
export async function fetchEnterpriseExternalIdentities(
  cfg: GitHubConfig
): Promise<Map<string, ExternalIdentity>> {
  const map = new Map<string, ExternalIdentity>();

  for await (const page of paginate<RawExtId>(
    cfg.graphqlUrl,
    cfg.token,
    ENTERPRISE_EXT_ID_QUERY,
    { slug: cfg.enterpriseSlug },
    d => {
      const raw = d as EnterpriseExtIdData;
      if (!raw.enterprise) {
        throw new Error(`Enterprise '${cfg.enterpriseSlug}' not found or not accessible.`);
      }

      return (
        raw.enterprise.ownerInfo?.samlIdentityProvider?.externalIdentities ?? {
          nodes: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        }
      );
    }
  )) {
    for (const e of page) {
      if (!e.user?.login) continue;
      const nextIdentity: ExternalIdentity = {
        scimUsername: e.scimIdentity?.username,
      };
      map.set(e.user.login, mergeExternalIdentity(map.get(e.user.login), nextIdentity));
    }
  }

  return map;
}

/** Returns a map of GitHub login → ExternalIdentity for the given org. */
export async function fetchOrgExternalIdentities(
  cfg: GitHubConfig,
  orgLogin: string
): Promise<Map<string, ExternalIdentity>> {
  const map = new Map<string, ExternalIdentity>();

  try {
    for await (const page of paginate<RawExtId>(
      cfg.graphqlUrl,
      cfg.token,
      EXT_ID_QUERY,
      { org: orgLogin },
      d => {
        const raw = d as ExtIdData;
        return (
          raw.organization?.samlIdentityProvider?.externalIdentities ?? {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          }
        );
      }
    )) {
      for (const e of page) {
        if (!e.user?.login) continue;
        const nextIdentity: ExternalIdentity = {
          scimUsername: e.scimIdentity?.username,
        };
        map.set(e.user.login, mergeExternalIdentity(map.get(e.user.login), nextIdentity));
      }
    }
  } catch {
    // Org may have no SAML provider configured – silently skip
  }

  return map;
}

// ─── 4. SCIM Users (REST) ───────────────────────────────────────────────────

interface ScimUsersPage {
  totalResults?: number;
  Resources?: ScimUser[];
}

async function fetchScimUsers(cfg: GitHubConfig, usersPath: string): Promise<ScimUser[]> {
  const users: ScimUser[] = [];
  const count = 100;
  let startIndex = 1;

  while (true) {
    const url = `${cfg.apiBaseUrl}${usersPath}?startIndex=${startIndex}&count=${count}`;
    const page = await restGet<ScimUsersPage | []>(url, cfg.scimToken);
    if (Array.isArray(page)) break;

    const resources = page.Resources ?? [];
    for (const resource of resources) {
      if (!resource.userName?.trim()) continue;
      users.push({
        externalId: resource.externalId?.trim() || undefined,
        userName: resource.userName.trim(),
        displayName: resource.displayName?.trim() || undefined,
      });
    }

    if (resources.length === 0) break;
    startIndex += resources.length;
    if (page.totalResults !== undefined && startIndex > page.totalResults) break;
  }

  return users;
}

/** Returns SCIM records for an Enterprise Managed Users enterprise. */
export function fetchEnterpriseScimUsers(cfg: GitHubConfig): Promise<ScimUser[]> {
  const enterprise = encodeURIComponent(cfg.enterpriseSlug);
  return fetchScimUsers(cfg, `/scim/v2/enterprises/${enterprise}/Users`);
}

/** Returns SCIM records provisioned for an organization. */
export function fetchOrgScimUsers(cfg: GitHubConfig, orgLogin: string): Promise<ScimUser[]> {
  const org = encodeURIComponent(orgLogin);
  return fetchScimUsers(cfg, `/scim/v2/organizations/${org}/Users`);
}

// ─── 5. Copilot Seats (REST, per org) ────────────────────────────────────────

interface RawCopilotSeat {
  assignee: { login: string; type: string };
  plan_type?: string | null;
  organization?: { login?: string };
  assigning_team?: { slug?: string; name?: string };
  pending_cancellation_date?: string | null;
  last_activity_at?: string | null;
  last_activity_editor?: string | null;
}

interface CopilotSeatsPage {
  total_seats?: number;
  seats?: RawCopilotSeat[];
}

function normalizeAssigningTeamLabel(assigningTeam?: { slug?: string; name?: string }): string | undefined {
  const slug = assigningTeam?.slug?.trim();
  if (slug) {
    return slug.startsWith('ent:') ? slug.slice('ent:'.length) : slug;
  }

  const name = assigningTeam?.name?.trim();
  return name || undefined;
}

function mapSeatToLicense(seat: RawCopilotSeat, fallbackOrg?: string): CopilotLicense {
  const normalizedPlan =
    seat.plan_type === 'business' || seat.plan_type === 'enterprise'
      ? seat.plan_type
      : 'unknown';

  const assignedOrg = seat.organization?.login ?? fallbackOrg;
  const assigningTeam = normalizeAssigningTeamLabel(seat.assigning_team);

  return {
    assigned: true,
    planType: normalizedPlan,
    lastActivityAt: seat.last_activity_at ?? undefined,
    lastActivityEditor: seat.last_activity_editor ?? undefined,
    pendingCancellation: !!seat.pending_cancellation_date,
    assignedOrg,
    assigningTeam,
  };
}

/** Returns a map of GitHub login → CopilotLicense for enterprise-level seats (includes team-only assignments). */
export async function fetchEnterpriseCopilotSeats(
  cfg: GitHubConfig
): Promise<Map<string, CopilotLicense>> {
  const map = new Map<string, CopilotLicense>();
  let page = 1;

  while (true) {
    const url = `${cfg.apiBaseUrl}/enterprises/${cfg.enterpriseSlug}/copilot/billing/seats?per_page=100&page=${page}`;
    const resp = await restGet<CopilotSeatsPage | RawCopilotSeat[]>(url, cfg.token);

    const seats: RawCopilotSeat[] = Array.isArray(resp)
      ? (resp as RawCopilotSeat[])
      : ((resp as CopilotSeatsPage).seats ?? []);

    for (const seat of seats) {
      if (seat.assignee?.type !== 'User') continue;
      map.set(seat.assignee.login, mapSeatToLicense(seat));
    }

    if (seats.length < 100) break;
    page++;
  }

  return map;
}

/** Returns a map of GitHub login → CopilotLicense for the given org. */
export async function fetchOrgCopilotSeats(
  cfg: GitHubConfig,
  orgLogin: string
): Promise<Map<string, CopilotLicense>> {
  const map = new Map<string, CopilotLicense>();
  let page = 1;

  while (true) {
    const url = `${cfg.apiBaseUrl}/orgs/${orgLogin}/copilot/billing/seats?per_page=100&page=${page}`;
    const resp = await restGet<CopilotSeatsPage | RawCopilotSeat[]>(url, cfg.token);

    const seats: RawCopilotSeat[] = Array.isArray(resp)
      ? (resp as RawCopilotSeat[])
      : ((resp as CopilotSeatsPage).seats ?? []);

    for (const s of seats) {
      if (s.assignee?.type !== 'User') continue;
      map.set(s.assignee.login, mapSeatToLicense(s, orgLogin));
    }

    if (seats.length < 100) break;
    page++;
  }

  return map;
}
