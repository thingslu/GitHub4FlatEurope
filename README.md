# GitHub Enterprise User Extractor

Extracts enterprise users and enriches them with:
- organization membership
- SAML/SCIM external identity details
- Copilot seat assignment details (Business/Enterprise), including last activity metadata

The tool is built in TypeScript and uses both GitHub GraphQL and REST APIs. It supports enterprise-level data collection first, with org-level fallback where needed.

## What This Project Does

The exporter:
1. Fetches organizations in an enterprise
2. Fetches enterprise members
3. Fetches external identities (SAML/SCIM)
4. Fetches Copilot billing seats
5. Merges everything by GitHub login
6. Exports results to CSV or JSON

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
- `src/types/index.ts`: domain and config types

## Prerequisites

- Node.js 20+
- Access token with enterprise/org/copilot-billing read access
- Enterprise slug (e.g. from `https://github.com/enterprises/<slug>`)

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

## Usage

Run CSV export (default):

```bash
npm run export:csv
```

Run JSON export:

```bash
npm run export:json
```

Build TypeScript:

```bash
npm run build
```

## Configuration

Environment variables:
- `GITHUB_TOKEN`: PAT used for API calls
- `ENTERPRISE_SLUG`: enterprise identifier
- `GRAPHQL_URL`: GraphQL endpoint
- `API_BASE_URL`: REST base URL
- `OUTPUT_FORMAT`: `csv` or `json`
- `OUTPUT_FILE`: output path
- `FILTER_STRICT`: when `true`, exports only users that match all three conditions:
  - has external identity
  - has Copilot seat
  - has at least one organization

## Output Fields (CSV)

Includes core identity and licensing fields such as:
- `login`, `name`, `email`, `organizations`
- `saml_name_id`, `saml_username`, `scim_username`
- `copilot_assigned`, `copilot_plan_type`, `copilot_org`
- `copilot_last_activity`, `copilot_last_editor`, `copilot_pending_cancellation`

## Notes

- The exporter prefers enterprise-level endpoints where available.
- For constrained environments, HTTP(S) proxy variables (`HTTPS_PROXY`, `HTTP_PROXY`) are supported.
- Keep `.env` private and never commit secrets.
