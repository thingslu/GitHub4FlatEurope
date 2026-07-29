import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { stringify } from 'csv-stringify/sync';
import {
  fetchEnterpriseOrgs,
  fetchEnterpriseMembers,
  fetchEnterpriseExternalIdentities,
  fetchEnterpriseScimUsers,
  fetchEnterpriseCopilotSeats,
  fetchOrgExternalIdentities,
  fetchOrgScimUsers,
  fetchOrgCopilotSeats,
} from './api/github.js';
import { loadEntraUsers } from './identity/entra-extract.js';
import { resolveUserPrincipalNames } from './identity/upn.js';
import type { ScimUser } from './identity/upn.js';
import type { GitHubConfig, EnterpriseUser, ProgressReporter } from './types/index.js';

// ─── Config ───────────────────────────────────────────────────────────────────

function getConfig(): GitHubConfig {
  const required = ['GITHUB_TOKEN', 'ENTERPRISE_SLUG', 'GRAPHQL_URL', 'API_BASE_URL'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`\n[ERROR] Missing environment variables: ${missing.join(', ')}`);
    console.error('Copy .env.example to .env and fill in the values.\n');
    process.exit(1);
  }

  return {
    token: process.env.GITHUB_TOKEN!,
    enterpriseSlug: process.env.ENTERPRISE_SLUG!,
    graphqlUrl: process.env.GRAPHQL_URL!,
    apiBaseUrl: process.env.API_BASE_URL!,
    scimToken: process.env.SCIM_TOKEN || process.env.GITHUB_TOKEN!,
  };
}

// ─── Progress reporter ────────────────────────────────────────────────────────

const reporter: ProgressReporter = {
  step(msg) { console.log(`  ▶  ${msg}`); },
  warn(msg) { console.warn(`  ⚠  ${msg}`); },
};

// ─── Orchestration ────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  const cfg = getConfig();

  const format = (process.env.OUTPUT_FORMAT ?? 'csv').toLowerCase() as 'csv' | 'json';

  // CLI flag overrides env
  const args = process.argv.slice(2);
  const fmtArg = args.find((a: string) => a.startsWith('--format='))?.split('=')[1]
    ?? (args.includes('--format') ? args[args.indexOf('--format') + 1] : undefined);
  const finalFormat = (fmtArg ?? format) as 'csv' | 'json';
  const defaultFile = finalFormat === 'json' ? './output/users.json' : './output/users.csv';
  const outputFile = process.env.OUTPUT_FILE ?? defaultFile;

  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║  GitHub Enterprise – User Extraction Tool   ║');
  console.log('╚══════════════════════════════════════════════╝\n');
  console.log(`  Enterprise : ${cfg.enterpriseSlug}`);
  console.log(`  GraphQL    : ${cfg.graphqlUrl}`);
  console.log(`  Output     : ${outputFile} (${finalFormat.toUpperCase()})\n`);

  const entraUsersFile = process.env.ENTRA_USERS_FILE?.trim() || './input/entra-users.json';
  const entraExtract = fs.existsSync(entraUsersFile) ? loadEntraUsers(entraUsersFile) : undefined;
  if (entraExtract) {
    console.log(`  Entra ID   : ${entraExtract.users.length} authoritative user record(s)`);
    if (entraExtract.skipped > 0) {
      reporter.warn(`${entraExtract.skipped} Entra extract record(s) without an ID or UPN were skipped.`);
    }
  } else {
    reporter.warn(`Entra extract '${entraUsersFile}' was not found; user_principal_name will be empty.`);
  }

  // 1. Fetch all organisations
  reporter.step('Fetching enterprise organisations…');
  const orgs = await fetchEnterpriseOrgs(cfg);
  console.log(`     → ${orgs.length} organisation(s) found`);

  // 2. Fetch all enterprise members
  reporter.step('Fetching enterprise members…');
  const users = await fetchEnterpriseMembers(cfg);
  console.log(`     → ${users.length} member(s) found`);

  // 3-5. Fetch external identities, SCIM records, and Copilot seats.
  const extIdByLogin = new Map<string, NonNullable<EnterpriseUser['externalIdentity']>>();
  const copilotByLogin = new Map<string, EnterpriseUser['copilotLicense']>();
  const copilotSeatAssignmentByPlan = {
    business: 0,
    enterprise: 0,
    unknown: 0,
  };
  const copilotUsersByPlan = {
    business: new Set<string>(),
    enterprise: new Set<string>(),
    unknown: new Set<string>(),
  };

  // 3a. Prefer enterprise-level external identities when available.
  let useOrgExternalIdentityFallback = true;
  try {
    reporter.step('Fetching enterprise-level external identities…');
    const enterpriseExtIds = await fetchEnterpriseExternalIdentities(cfg);
    enterpriseExtIds.forEach((v, k) => extIdByLogin.set(k, v));
    console.log(`     → ${enterpriseExtIds.size} enterprise external identity/ies`);

    if (enterpriseExtIds.size > 0) {
      useOrgExternalIdentityFallback = false;
    }
  } catch (err) {
    reporter.warn(`Enterprise-level external identities unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }

  // REST SCIM externalId bridges GitHub identities to Entra object IDs.
  const scimUsers: ScimUser[] = [];
  let useOrgScimFallback = Boolean(entraExtract);
  if (entraExtract) {
    try {
      reporter.step('Fetching enterprise SCIM records via REST…');
      const enterpriseScimUsers = await fetchEnterpriseScimUsers(cfg);
      scimUsers.push(...enterpriseScimUsers);
      console.log(`     → ${enterpriseScimUsers.length} enterprise SCIM record(s)`);

      if (enterpriseScimUsers.length > 0) {
        useOrgScimFallback = false;
      }
    } catch (err) {
      reporter.warn(`Enterprise SCIM REST API unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 5a. Prefer enterprise-level Copilot seats when available.
  let useOrgCopilotFallback = true;
  try {
    reporter.step('Fetching enterprise-level Copilot seats…');
    const enterpriseSeats = await fetchEnterpriseCopilotSeats(cfg);
    for (const [login, license] of enterpriseSeats) {
      const plan = license.planType ?? 'unknown';
      copilotSeatAssignmentByPlan[plan]++;
      copilotUsersByPlan[plan].add(login);
      copilotByLogin.set(login, license);
    }

    console.log(`     → ${enterpriseSeats.size} enterprise Copilot seat user(s)`);
    if (enterpriseSeats.size > 0) {
      useOrgCopilotFallback = false;
    }
  } catch (err) {
    reporter.warn(`Enterprise-level Copilot seats unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }

  for (const org of orgs) {
    if (useOrgExternalIdentityFallback) {
      reporter.step(`[${org.login}] Fetching external identities…`);
      try {
        const extIds = await fetchOrgExternalIdentities(cfg, org.login);
        extIds.forEach((v, k) => { if (!extIdByLogin.has(k)) extIdByLogin.set(k, v); });
        console.log(`     → ${extIds.size} linked identity/ies`);
      } catch (err) {
        reporter.warn(`[${org.login}] External identities skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (useOrgScimFallback) {
      reporter.step(`[${org.login}] Fetching SCIM records via REST…`);
      try {
        const orgScimUsers = await fetchOrgScimUsers(cfg, org.login);
        scimUsers.push(...orgScimUsers);
        console.log(`     → ${orgScimUsers.length} SCIM record(s)`);
      } catch (err) {
        reporter.warn(`[${org.login}] SCIM REST API unavailable: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (useOrgCopilotFallback) {
      reporter.step(`[${org.login}] Fetching Copilot seats…`);
      try {
        const seats = await fetchOrgCopilotSeats(cfg, org.login);

        for (const [login, license] of seats) {
          const plan = license.planType ?? 'unknown';
          copilotSeatAssignmentByPlan[plan]++;
          copilotUsersByPlan[plan].add(login);

          if (!copilotByLogin.has(login)) {
            copilotByLogin.set(login, license);
            continue;
          }

          // If a user appears with multiple plans across orgs, prefer enterprise.
          const existing = copilotByLogin.get(login);
          if (existing?.planType === 'business' && license.planType === 'enterprise') {
            copilotByLogin.set(login, license);
          }
        }

        console.log(`     → ${seats.size} Copilot seat(s)`);
      } catch (err) {
        reporter.warn(`[${org.login}] Copilot seats skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // 6. Merge data onto each user
  for (const user of users) {
    const ext = extIdByLogin.get(user.login);
    if (ext) user.externalIdentity = ext;

    const seat = copilotByLogin.get(user.login);
    if (seat) user.copilotLicense = seat;
  }

  const upnResolution = entraExtract
    ? resolveUserPrincipalNames(users, scimUsers, entraExtract.users)
    : undefined;
  if (upnResolution) {
    console.log(`     → ${upnResolution.matchedByExternalId} UPN(s) matched by Entra object ID`);
    console.log(`     → ${upnResolution.matchedByDisplayName} UPN(s) matched by guarded display name`);
    if (upnResolution.ambiguous > 0) {
      reporter.warn(`${upnResolution.ambiguous} UPN match(es) were ambiguous and left empty.`);
    }
    if (upnResolution.unresolved > 0) {
      reporter.warn(`${upnResolution.unresolved} UPN(s) could not be resolved from the Entra extract.`);
    }
  }

  // Do not append Copilot users missing from enterprise members; these are typically
  // users already removed from organizations but still visible in billing seats history.

  // 6a. Filter users with all three criteria: ExternalIdentity + Copilot License + Organization
  const usersWithAllCriteria = users.filter(user =>
    user.externalIdentity && // Has external identity (SAML/SCIM)
    user.copilotLicense?.assigned && // Has assigned Copilot license
    user.organizations.length > 0 // Belongs to at least one organization
  );

  const reportStats = {
    total: users.length,
    withUserPrincipalName: users.filter(user => user.userPrincipalName).length,
    withExternalIdentity: users.filter(u => u.externalIdentity).length,
    withCopilotLicense: users.filter(u => u.copilotLicense?.assigned).length,
    copilotSeatAssignmentsBusiness: copilotSeatAssignmentByPlan.business,
    copilotSeatAssignmentsEnterprise: copilotSeatAssignmentByPlan.enterprise,
    copilotSeatAssignmentsUnknown: copilotSeatAssignmentByPlan.unknown,
    copilotUsersBusiness: copilotUsersByPlan.business.size,
    copilotUsersEnterprise: copilotUsersByPlan.enterprise.size,
    copilotUsersUnknown: copilotUsersByPlan.unknown.size,
    withOrganization: users.filter(u => u.organizations.length > 0).length,
    withAllCriteria: usersWithAllCriteria.length,
  };

  console.log(`\n📊  User Statistics:`);
  console.log(`     • Total users: ${reportStats.total}`);
  console.log(`     • With authoritative Entra UPN: ${reportStats.withUserPrincipalName}`);
  console.log(`     • With ExternalIdentity: ${reportStats.withExternalIdentity}`);
  console.log(`     • With Copilot License: ${reportStats.withCopilotLicense}`);
  console.log(`     • Copilot seat assignments (Business): ${reportStats.copilotSeatAssignmentsBusiness}`);
  console.log(`     • Copilot seat assignments (Enterprise): ${reportStats.copilotSeatAssignmentsEnterprise}`);
  console.log(`     • Copilot seat assignments (Unknown): ${reportStats.copilotSeatAssignmentsUnknown}`);
  console.log(`     • Copilot unique users (Business): ${reportStats.copilotUsersBusiness}`);
  console.log(`     • Copilot unique users (Enterprise): ${reportStats.copilotUsersEnterprise}`);
  console.log(`     • Copilot unique users (Unknown): ${reportStats.copilotUsersUnknown}`);
  console.log(`     • With Organization: ${reportStats.withOrganization}`);
  console.log(`     • With ALL three criteria: ${reportStats.withAllCriteria}\n`);

  // 7. Write output (all users by default, or filtered if FILTER_STRICT env var is set)
  const shouldFilterStrict = process.env.FILTER_STRICT?.toLowerCase() === 'true';
  const usersToExport = shouldFilterStrict ? usersWithAllCriteria : users;

  reporter.step(`Writing ${usersToExport.length} user(s) to ${outputFile}…`);
  const dir = path.dirname(outputFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  if (finalFormat === 'json') {
    fs.writeFileSync(outputFile, JSON.stringify(usersToExport, null, 2), 'utf-8');
  } else {
    const rows = usersToExport.map(u => ({
      login: u.login,
      name: u.name,
      email: u.email,
      user_principal_name: u.userPrincipalName ?? '',
      upn_match_method: u.upnMatchMethod ?? '',
      organizations: u.organizations.join(';'),
      saml_name_id: u.externalIdentity?.samlNameId ?? '',
      saml_username: u.externalIdentity?.samlUsername ?? '',
      scim_username: u.externalIdentity?.scimUsername ?? '',
      given_name: u.externalIdentity?.givenName ?? '',
      family_name: u.externalIdentity?.familyName ?? '',
      copilot_assigned: u.copilotLicense.assigned,
      copilot_plan_type: u.copilotLicense.planType ?? '',
      copilot_org: u.copilotLicense.assignedOrg ?? '',
      copilot_last_activity: u.copilotLicense.lastActivityAt ?? '',
      copilot_last_editor: u.copilotLicense.lastActivityEditor ?? '',
      copilot_pending_cancellation: u.copilotLicense.pendingCancellation,
    }));

    const csv = stringify(rows, { header: true });
    fs.writeFileSync(outputFile, csv, 'utf-8');
  }

  const filterMsg = shouldFilterStrict ? ' (filtered to users with all three criteria)' : '';
  console.log(`\n✅  Done. ${usersToExport.length} users exported to ${outputFile}${filterMsg}\n`);
}

run().catch(err => {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause;
    const causeMsg = cause instanceof Error ? cause.message : cause ? String(cause) : '';
    console.error(`\n[FATAL] ${err.message}${causeMsg ? ` | cause: ${causeMsg}` : ''}`);
  } else {
    console.error('\n[FATAL]', String(err));
  }
  process.exit(1);
});
