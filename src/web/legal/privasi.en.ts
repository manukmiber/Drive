// English translation of the Privacy Policy (privasi.id.ts). The Indonesian text is the binding one.
import { LEGAL_CONTACTS_EN as C } from './contacts';

export const title = 'Privacy Policy for Zeiko Drive and Zeiko S3';

export const body = `## 1. Summary

The Zeiko team does not open or look at the contents of your files by hand. Every uploaded file is checked by an automated scanning system for malware and child sexual abuse material (CSAM), without any person involved as long as nothing is found.

This policy explains what data Zeiko collects, how it is used and protected, when it may be shared, and your rights under Law No. 27 of 2022 on Personal Data Protection (UU PDP). It applies to Zeiko Drive and Zeiko S3, and is part of Zeiko's Terms of Service.

## 2. Data We Collect

| Type of data | Examples | Source |
| --- | --- | --- |
| Account data | Name, email, username, phone number (if given), password as a hash | Given at sign-up |
| Payment data | Plan name, transaction history, payment method. Full card numbers are processed by the payment provider, not stored by Zeiko | When subscribing to a paid plan |
| Technical data | IP address, sign-in times, user agent/device, API request and file access logs | Recorded automatically while you use the Service |
| Content | Files and objects you upload to Zeiko Drive or Zeiko S3 | Uploaded by you |
| Content metadata | File name, size, type, upload time, file hash, Public Link or Bucket settings | Created automatically by the system |
| Communications | Emails to support, abuse reports, appeals | Sent by you |

## 3. Access to Your Files

The Zeiko team does not open, read or look at the contents of your files in day-to-day operations. Files are only processed by automated systems (see Section 4).

Authorised Zeiko staff access files by hand only in the following cases, and only the file concerned:

1. The automated scanning system flags the file as possible malware or CSAM and it needs to be confirmed.
2. There is an abuse report or a copyright report (including DMCA) about the file.
3. You yourself ask for technical help that needs access to a particular file.
4. There is an official request from law enforcement or a court order.

Every manual access is recorded in an internal log covering who accessed it, when, and why.

## 4. Automated Scanning

Every file uploaded to Zeiko Drive or Zeiko S3 is scanned automatically straight away using the following services.

| Service | What it checks | Data sent |
| --- | --- | --- |
| VirusTotal | Malware, viruses and harmful files | The file's hash (fingerprint). Files VirusTotal does not know yet may be uploaded in full for analysis |
| Cloudflare CSAM Scanning Tool | Images that match a database of known CSAM hashes | Processed on Cloudflare's network |
| Hive and Thorn | Known CSAM (hash matching) and unknown CSAM (AI-based classification) in images and videos | Images/videos or a representation of them, depending on the service |

What you should know:

- Files uploaded in full to VirusTotal may be shared by VirusTotal with the security community and its customers. Do not keep files holding confidential information in an executable format (for example .exe, .apk, or documents with macros) if you do not want third parties to analyse them.
- If a file is detected as malware, it may be quarantined and its Public Link disabled while it is followed up under the Terms of Service.
- If a file matches CSAM, it is blocked straight away and reported as described in Section 6.
- Automated systems can be wrong. If you believe your file was flagged by mistake, appeal under Section 8 of the Terms of Service.

## 5. How Data Is Used

Zeiko uses your data only for the following purposes:

1. Providing, running and maintaining the Service, including storing and serving your files.
2. Managing accounts, billing and payments.
3. Keeping the Service secure, including detecting malware, CSAM, unauthorised access and misuse.
4. Enforcing the Terms of Service and handling reports, appeals and takedown requests.
5. Sending important notices about accounts, security and policy changes.
6. Meeting legal obligations.

Zeiko does **not** sell your data, does not use the contents of your files for advertising, and does not use the contents of your files to train AI models.

## 6. Sharing Data with Third Parties

Zeiko shares data only with the following parties, and only as far as needed:

- **Security scanning providers**: VirusTotal, Cloudflare, Hive and Thorn, for scanning as described in Section 4.
- **Infrastructure and payment providers**: server, network and payment processing providers working on Zeiko's behalf.
- **NCMEC and the Indonesian National Police**: if CSAM is found, Zeiko reports it and hands over account information, IP addresses, access logs and the Content shown to be in violation, without notifying you first.
- **Law enforcement and other competent authorities**: for other violations of the law, or on official request and court order.
- **Copyright reporters**: only the information that the report has been acted on. Your personal data is not given to the reporter without a legal basis.

**Transfers outside Indonesia.** Some of the providers above, including VirusTotal, Cloudflare, Hive, Thorn and NCMEC, are located or process data outside Indonesia. Zeiko makes sure these transfers follow the UU PDP and go only to parties with adequate data protection standards.

## 7. Storage, Retention and Security

| Data | How long it is kept |
| --- | --- |
| Content and metadata | While the account is active. Permanently deleted at most 30 days after you delete it or delete the account |
| Account data | While the account is active, then deleted at most 30 days after the account is deleted |
| Access logs and IP addresses | ${C.logRetention} |
| Transaction data | As required by tax and accounting obligations |
| Data related to Category A violations | As long as needed for legal proceedings |

**Security.** Zeiko protects data with encryption in transit (HTTPS/TLS), ${C.atRest}, role-based limits on internal access, and a record of every manual access. No system is completely secure, so Zeiko will notify you and the relevant authorities within 3×24 hours at most if a personal data protection failure happens, as the UU PDP requires.

## 8. Your Rights

Under the UU PDP, you have the right to:

1. Know about and get a copy of the personal data Zeiko holds about you.
2. Update or correct inaccurate data.
3. Delete your personal data and your account.
4. Withdraw your consent to the processing of data, with the consequence that the Service may no longer be usable.
5. Object to particular processing of data.

Send requests to ${C.privacy}. Zeiko will respond within 3×24 hours at most. These rights may be limited where the data is needed for legal proceedings, including data related to Category A violations.

## 9. Other Provisions

1. **Cookies.** Zeiko uses the cookies needed for signing in and session security. Zeiko does not use advertising cookies or third-party trackers.
2. **Children.** The Service is not meant for children under 13. Users aged 13 to 17 must have the permission of a parent or guardian. If Zeiko learns that a child's data was collected without that permission, the data will be deleted.
3. **Policy changes.** Important changes are announced by email or in the dashboard at least 7 days before they take effect.

**Contact**

- Privacy questions and requests: ${C.privacy}
- General support: ${C.support}
- Abuse reports: ${C.abuse}
`;
