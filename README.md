# GitHub Enterprise User Extractor

Extracts enterprise users and enriches them with:
- organization membership
- SAML/SCIM external identity details
- authoritative Microsoft Entra ID user principal names (UPNs)
- Copilot seat assignment details (Business/Enterprise), including last activity metadata

The tool is built in TypeScript and uses both GitHub GraphQL and REST APIs. It supports enterprise-level data collection first, with org-level fallback where needed.

## What This Project Does

The exporter:
1. Loads an Entra ID extract containing `id`, `userPrincipalName`, and `displayName`
2. Fetches organizations and enterprise members from GitHub
3. Fetches linked external identities through GitHub GraphQL
4. Fetches SCIM records, including `externalId`, through GitHub REST
5. Fetches Copilot billing seats
6. Resolves UPNs from Entra ID and merges everything by GitHub login
7. Exports results to CSV or JSON

It also prints useful run statistics, including total users, users with external identity, and Copilot seat counts by plan.

## Tech Stack

- Node.js (ESM)
- TypeScript
- `tsx` for execution
- `dotenv` for configuration
- `csv-stringify` for CSV generation
- `undici` for proxy-aware HTTP requests

## Project Structure

- `src/index.ts`: orchestration, merge logic, filtering, export
- `src/api/github.ts`: GraphQL/REST calls, pagination, mapping
- `src/identity/entra-extract.ts`: Entra JSON extract loading
- `src/identity/upn.ts`: deterministic GitHub/SCIM/Entra matching
- `src/types/index.ts`: domain and config types
- `scripts/export-entra-users.ps1`: read-only Entra ID export

## Prerequisites

- Node.js 20+
- Access token with enterprise/org/copilot-billing read access
- Enterprise slug (e.g. from `https://github.com/enterprises/<slug>`)
- PowerShell 7 and Microsoft Graph PowerShell for the Entra export
- Delegated Microsoft Graph `User.Read.All` permission

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create your local env file from the template:

```bash
cp .env.example .env
```

3. Fill `.env` with your values (`GITHUB_TOKEN`, `ENTERPRISE_SLUG`, etc.).

4. Install the two Microsoft Graph PowerShell modules used by the extract:

```powershell
Install-Module Microsoft.Graph.Authentication,Microsoft.Graph.Users -Scope CurrentUser
```

5. Sign in and create the local Entra extract:

```bash
npm run export:entra
```

The extract is written to `input/entra-users.json`, which is excluded from Git.

## Usage

Run CSV export (default):

```bash
npm run export:csv
```

Run JSON export:

```bash
npm run export:json
```

Refresh the authoritative Entra UPN extract before an export:

```bash
npm run export:entra
```

Build TypeScript:

```bash
npm run build
```

## Configuration

Environment variables:
- `GITHUB_TOKEN`: PAT used for API calls
- `SCIM_TOKEN`: optional PAT for read-only SCIM REST calls; falls back to `GITHUB_TOKEN`
- `ENTRA_USERS_FILE`: optional Entra JSON extract path; defaults to `./input/entra-users.json`
- `ENTERPRISE_SLUG`: enterprise identifier
- `GRAPHQL_URL`: GraphQL endpoint
- `API_BASE_URL`: REST base URL
- `OUTPUT_FORMAT`: `csv` or `json`
- `OUTPUT_FILE`: output path
- `FILTER_STRICT`: when `true`, exports only users that match all three conditions:
  - has external identity
  - has Copilot seat
  - has at least one organization

For Enterprise Managed Users, GitHub recommends a classic PAT associated with the setup user and scoped to `scim:enterprise`. An enterprise owner can use a classic PAT with `admin:enterprise` for read-only SCIM `GET` requests. For organization-level SCIM, the token must belong to an organization owner, have `admin:org`, and be authorized for the SAML SSO organization.

## UPN Resolution

The CSV writer does not truncate values. Live validation in this enterprise showed that both GitHub GraphQL `scimIdentity.username` and REST SCIM `userName` contain the same truncated value. GitHub therefore is not treated as the authoritative source for UPN.

The authoritative value is Entra ID `userPrincipalName`. The primary match follows this chain:

`GitHub login` → GraphQL SCIM username → exact REST SCIM `userName` → SCIM `externalId` → Entra `id` → Entra `userPrincipalName`

For Microsoft Entra provisioning, SCIM `externalId` is the Entra object ID. This exact identifier join is used even when names differ.

If the object-ID path is unavailable, display name is a secondary key. A display-name candidate is accepted only when exactly one Entra record also has a `userPrincipalName` for which the GitHub SCIM value is a case-insensitive strict prefix. Duplicate or conflicting candidates remain empty and are reported as ambiguous. Email is never used as a UPN substitute.

The raw GitHub value remains in `scim_username` for traceability. The authoritative result is written separately to `user_principal_name`, with `upn_match_method` set to `external_id` or `display_name`.

## Output Fields (CSV)

Includes core identity and licensing fields such as:
- `login`, `name`, `email`, `organizations`
- `user_principal_name`, `upn_match_method`
- `saml_name_id`, `saml_username`, `scim_username` (raw GitHub value)
- `copilot_assigned`, `copilot_plan_type`, `copilot_org`
- `copilot_last_activity`, `copilot_last_editor`, `copilot_pending_cancellation`

## Notes

- The exporter prefers enterprise-level endpoints where available.
- For constrained environments, HTTP(S) proxy variables (`HTTPS_PROXY`, `HTTP_PROXY`) are supported.
- Keep `.env` private and do not commit the Entra extract or other identity data.
