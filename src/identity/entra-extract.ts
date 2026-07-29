import fs from 'node:fs';
import path from 'node:path';
import type { EntraUser } from './upn.js';

export interface EntraExtract {
  users: EntraUser[];
  skipped: number;
}

function readString(record: Record<string, unknown>, propertyName: string): string {
  const entry = Object.entries(record).find(
    ([key]) => key.toLowerCase() === propertyName.toLowerCase()
  );
  return typeof entry?.[1] === 'string' ? entry[1].trim() : '';
}

function readStringArray(record: Record<string, unknown>, propertyName: string): string[] {
  const entry = Object.entries(record).find(
    ([key]) => key.toLowerCase() === propertyName.toLowerCase()
  );
  if (!Array.isArray(entry?.[1])) return [];
  return entry[1]
    .filter((value): value is string => typeof value === 'string')
    .map(value => value.trim())
    .filter(Boolean);
}

function extractPrimarySmtp(proxyAddresses: string[]): string {
  const primary = proxyAddresses.find(address => address.startsWith('SMTP:'));
  return primary ? primary.slice('SMTP:'.length).trim() : '';
}

export function parseEntraUsers(value: unknown): EntraExtract {
  const records = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { value?: unknown }).value)
      ? (value as { value: unknown[] }).value
      : undefined;

  if (!records) {
    throw new Error('Entra extract must be a JSON array or a Microsoft Graph response with a value array.');
  }

  const users: EntraUser[] = [];
  let skipped = 0;

  for (const rawRecord of records) {
    if (!rawRecord || typeof rawRecord !== 'object' || Array.isArray(rawRecord)) {
      skipped++;
      continue;
    }

    const record = rawRecord as Record<string, unknown>;
    const id = readString(record, 'id');
    const userPrincipalName = readString(record, 'userPrincipalName');
    const displayName = readString(record, 'displayName');
    const amCompanyCode = readString(record, 'extension_c77e68a23a6a4f91af48a93b63f95e0f_AMCOMPANYCODE');
    const amBuCode = readString(record, 'extension_c77e68a23a6a4f91af48a93b63f95e0f_AMBUCODE');
    const amSegmentCode = readString(record, 'extension_c77e68a23a6a4f91af48a93b63f95e0f_AMSEGMENTCODE');
    const smtp = readString(record, 'SMTP')
      || extractPrimarySmtp(readStringArray(record, 'proxyAddresses'));

    if (!id || !userPrincipalName) {
      skipped++;
      continue;
    }

    users.push({
      id,
      userPrincipalName,
      displayName,
      amCompanyCode,
      amBuCode,
      amSegmentCode,
      smtp,
    });
  }

  return { users, skipped };
}

export function loadEntraUsers(filePath: string): EntraExtract {
  const resolvedPath = path.resolve(filePath);
  let text: string;

  try {
    text = fs.readFileSync(resolvedPath, 'utf8').replace(/^\uFEFF/, '');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read Entra extract '${resolvedPath}': ${message}`);
  }

  try {
    return parseEntraUsers(JSON.parse(text) as unknown);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid Entra extract '${resolvedPath}': ${message}`);
  }
}