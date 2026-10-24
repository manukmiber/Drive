// The addresses the policies give, and the two blanks the owner left in them (ADR-045), in one
// place. Support and privacy go to the operator's address until Zeiko has dedicated mailboxes.
import { OPERATOR_EMAIL } from '../../shared/constants';

const base = {
  support: OPERATOR_EMAIL,
  abuse: 'abuse@zeiko.biz.id',
  privacy: OPERATOR_EMAIL,
  website: 'https://zeiko.biz.id',
};

/** `log_retention_days` (90 by default) and what is actually encrypted at rest (R2 does that). */
export const LEGAL_CONTACTS_ID = {
  ...base,
  logRetention: '90 hari',
  atRest: 'enkripsi saat disimpan untuk file (dilakukan Cloudflare R2)',
};

export const LEGAL_CONTACTS_EN = {
  ...base,
  logRetention: '90 days',
  atRest: 'encryption at rest for files (done by Cloudflare R2)',
};
