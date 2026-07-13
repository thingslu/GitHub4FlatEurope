// ─── Configuration ────────────────────────────────────────────────────────────

export interface GitHubConfig {
  /** GraphQL endpoint, e.g. https://api.github.com/graphql */
  graphqlUrl: string;
  /** REST base URL, e.g. https://api.github.com */
  apiBaseUrl: string;
  /** Enterprise slug as it appears in https://github.com/enterprises/<slug> */
  enterpriseSlug: string;
  /** Personal Access Token with enterprise:admin + read:org + manage_billing:copilot */
  token: string;
}

// ─── Domain models ────────────────────────────────────────────────────────────

export interface Organization {
  login: string;
  name: string;
}

export interface ExternalIdentity {
  /** SAML NameID (usually the email in IdP) */
  samlNameId?: string;
  samlUsername?: string;
  scimUsername?: string;
  givenName?: string;
  familyName?: string;
}

export interface CopilotLicense {
  assigned: boolean;
  /** Copilot plan for the assignment seat */
  planType?: 'business' | 'enterprise' | 'unknown';
  /** ISO-8601 timestamp of last Copilot activity */
  lastActivityAt?: string;
  lastActivityEditor?: string;
  pendingCancellation: boolean;
  /** Organisation through which the seat is assigned */
  assignedOrg?: string;
}

export interface EnterpriseUser {
  login: string;
  name: string;
  email: string;
  /** All organisations in the enterprise the user belongs to */
  organizations: string[];
  externalIdentity?: ExternalIdentity;
  copilotLicense: CopilotLicense;
}

// ─── Progress reporting ───────────────────────────────────────────────────────

export interface ProgressReporter {
  step(message: string): void;
  warn(message: string): void;
}
