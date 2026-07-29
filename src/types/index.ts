// ─── Configuration ────────────────────────────────────────────────────────────

export interface GitHubConfig {
  /** GraphQL endpoint, e.g. https://api.github.com/graphql */
  graphqlUrl: string;
  /** REST base URL, e.g. https://api.github.com */
  apiBaseUrl: string;
  /** Enterprise slug as it appears in https://github.com/enterprises/<slug> */
  enterpriseSlug: string;
  /** Token used for GraphQL and Copilot billing API requests */
  token: string;
  /** Token used for read-only SCIM REST requests */
  scimToken: string;
}

// ─── Domain models ────────────────────────────────────────────────────────────

export interface Organization {
  login: string;
  name: string;
}

export interface ExternalIdentity {
  /** Raw SCIM username projected by GitHub; it may be truncated. */
  scimUsername?: string;
  /** SCIM externalId, typically the authoritative Entra object ID. */
  externalId?: string;
}

export type UpnMatchMethod = 'external_id' | 'display_name';

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
  /** Team through which the Copilot seat is assigned (org/team). */
  assigningTeam?: string;
}

export interface EnterpriseUser {
  login: string;
  name: string;
  /** Authoritative Entra ID userPrincipalName. */
  userPrincipalName?: string;
  /** Entra custom attribute extension_c77e68a23a6a4f91af48a93b63f95e0f_AMCOMPANYCODE. */
  amCompanyCode?: string;
  /** Entra custom attribute extension_c77e68a23a6a4f91af48a93b63f95e0f_AMBUCODE. */
  amBuCode?: string;
  /** Entra custom attribute extension_c77e68a23a6a4f91af48a93b63f95e0f_AMSEGMENTCODE. */
  amSegmentCode?: string;
  /** Primary SMTP address from Entra proxyAddresses (uppercase SMTP: entry). */
  smtp?: string;
  upnMatchMethod?: UpnMatchMethod;
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
