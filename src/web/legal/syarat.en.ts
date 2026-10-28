// English translation of the Terms of Service (syarat.id.ts). The Indonesian text is the binding one.
import { LEGAL_CONTACTS_EN as C } from './contacts';

export const title = 'Terms of Service for Zeiko Drive and Zeiko S3';

export const body = `## 1. Introduction and Definitions

By signing up for or using Zeiko Drive or Zeiko S3, you agree to be bound by these Terms of Service. If you do not agree, please do not use the Service.

In this document, the following terms have the following meanings:

- **Zeiko** or **We**: the operator and provider of Zeiko Drive and Zeiko S3.
- **Service**: Zeiko Drive (web/app file storage) and Zeiko S3 (object storage compatible with the S3 API), including all related features, APIs and dashboards.
- **User** or **You**: any person or entity that signs up for and/or uses the Service.
- **Content**: all files, objects, data, text, images, videos, applications or other material uploaded, stored or shared through the Service.
- **Bucket**: a storage container in Zeiko S3.
- **Credentials**: your account password, Access Key, Secret Key, API tokens and any other means of authentication tied to your account.
- **Public Link**: a sharing link or Bucket that others can access without signing in.

## 2. User Accounts

1. You must be at least 18 years old, or at least 13 years old with the permission and supervision of a parent or guardian.
2. The sign-up information you give must be true and kept up to date when it changes.
3. One person may have more than one account, but may not create a new account to get around the suspension or deletion of an earlier one.
4. You are fully responsible for keeping your Credentials confidential. All activity that happens through your account or Credentials is treated as your own.
5. Contact Us right away and recreate (rotate) your Access Key if you suspect your Credentials have leaked or someone else has accessed your account.
6. Accounts may not be sold, rented or transferred without Zeiko's written consent.

## 3. Prohibited Content and Activity

You may not upload, store, share or link to the following Content through the Service, in any format, whether private or public.

**Category A: Severe violations (zero tolerance)**

- Child sexual exploitation or abuse material (CSAM), including AI-generated images, illustrations or animations that depict children sexually.
- Terrorist content, violent extremism, or calls to violence.
- Malware, viruses, ransomware, trojans, spyware, keyloggers, stealers or other harmful software, including APKs modified to steal data or damage devices.
- Phishing pages or files, and material for fraud and account theft.
- Intimate content shared without the consent of the people in it.

**Category B: Serious violations**

- Online gambling apps, sites or promotional material in any form.
- Pornography as prohibited by the laws of Indonesia.
- Content related to the sale or purchase of narcotics, illegal weapons or other prohibited goods.
- Other people's personal data obtained unlawfully, such as leaked databases, ID card (KTP/KK) data or doxxing material.
- Hate speech based on ethnicity, religion, race or group (SARA), threats, or bullying of anyone.

**Category C: Copyright infringement and misuse of the Service**

- Pirated content or content that infringes intellectual property rights, such as films, anime, series, music, books, games or paid software shared without the rights holder's permission.
- Cracks, keygens or tools for breaking software licence protection.
- Using the Service for spam, mass hotlinking, or as a free CDN for third-party sites that break these terms.
- Using a Zeiko S3 Bucket to host a website, that is, serving HTML, CSS or JavaScript pages for visitors to open as a site. For websites, use Zeiko Hosting.
- Attempts to hack, test for security holes without permission, deliberately overload the system, or access other users' accounts and data.

The list above is not complete. Other content or activity that breaks the laws of the Republic of Indonesia is also prohibited, and Zeiko may decide whether a given piece of Content is a violation.

## 4. Sharing Files and Public Buckets

1. You are responsible for all Content shared through a Public Link or public Bucket, including who accesses it.
2. Public Links and public Buckets found to spread prohibited Content may be disabled by Zeiko right away without prior notice.
3. Zeiko may limit the bandwidth, number of downloads or Public Link features of accounts that show a pattern of misuse.
4. Do not store sensitive data in a public Bucket. A data leak caused by access settings you made yourself is your responsibility.

## 5. Fair Use Limits

1. Every plan has limits on storage capacity, bandwidth and number of API requests, as listed on the pricing page.
2. Use that goes well beyond the plan's limits or disrupts the stability of the system may be temporarily slowed down (throttled).
3. If the excessive use continues, Zeiko will contact you to offer a plan upgrade before taking further action.
4. Free accounts that are inactive (no sign-in and no API activity) for 12 months may be deleted after at least 30 days' notice.

## 6. Notice and Takedown Procedure

For Category B and C violations, Zeiko will give you the chance to remove the Content yourself. Category A violations do not go through this procedure and are acted on directly under Section 7.

1. Zeiko sends a notice to your registered email and your account dashboard. The notice states the file name or path, the reason for the violation and the removal deadline.
2. You must remove the Content within **24 hours** of the notice being sent.
3. While waiting, Zeiko may disable public access to the Content.
4. If the Content is not removed by the deadline, the account is **suspended** until it is. During a suspension you may only sign in to remove the Content in question.
5. If a suspension lasts more than 14 days without action, Zeiko may remove the Content itself or delete the account.

Not knowing about a notice because your email is inactive or unchecked is not an acceptable reason. Make sure your account email is always active.

## 7. Sanctions

Zeiko may impose sanctions unilaterally according to the level of violation below.

| Category | First violation | Repeated violation |
| --- | --- | --- |
| A (severe) | Permanent account deletion without warning, a ban on signing up again, and a report to law enforcement | Not applicable (the account is already deleted) |
| B (serious) | Notice and removal of Content (Section 6), or immediate suspension if the violation is clear and deliberate | Permanent account deletion |
| C (copyright and misuse) | Warning and removal of Content (Section 6) | 2nd warning: 7-day suspension. 3rd warning: account deletion |

**Reporting to the authorities.** For Category A violations, Zeiko reports straight away without first notifying the User. CSAM findings are reported to the National Center for Missing & Exploited Children (NCMEC) and the Indonesian National Police, and other Category A violations are reported to the Police and the competent authorities. The data handed over includes all account information (name, email, phone number and payment data, if any), IP addresses and access logs, and the Content shown to be in violation. Zeiko will also cooperate with official requests from the authorities in line with the applicable law.

## 8. Appeals and Objections

1. If you believe an action by Zeiko was wrong, you may appeal to ${C.support} no later than **7 days** after the sanction was imposed.
2. Include your account username/email, the file name or Bucket concerned, and an explanation or supporting evidence (for example proof of a licence or permission from the copyright holder).
3. Zeiko will review it and reply within **5 working days** at most.
4. If the appeal is accepted, the account and Content are restored as far as is still technically possible.
5. Category A violations that have been reported to law enforcement cannot be appealed through Zeiko.
6. The decision on an appeal is final.

## 9. Data After an Account Is Suspended or Deleted

1. **During a suspension**, Content stays stored, but Public Links, public Buckets and API access are disabled.
2. **After an account is deleted for a Category B or C violation**, you have **7 days** to download your other Content that does not break the rules. After that all data is permanently deleted and cannot be recovered.
3. **After an account is deleted for a Category A violation**, there is no chance to download data. Zeiko may keep the data temporarily, solely for legal proceedings.
4. **Deletion at your own request**: you may delete your account at any time from the dashboard. The data is permanently deleted within 30 days at most.

**Refunds.** There are no refunds for paid accounts that are suspended or deleted for breaking these Terms of Service. Any remaining plan period is forfeited.

## 10. Privacy and Access to Files

1. Zeiko respects the privacy of your Content and does not open file contents by hand without a lawful reason.
2. Zeiko may run automated scanning (for example hash matching and malware scanning) to detect prohibited Content, especially in publicly shared files.
3. Zeiko staff only look at the contents of a file when there is an abuse report, a suspicious automated scan result, a technical need for a fix you asked for, or an official request from law enforcement. Zeiko also records IP addresses and access logs for security, which may be handed to the authorities under Section 7.
4. Your personal data is handled under Zeiko's Privacy Policy and Law No. 27 of 2022 on Personal Data Protection.

## 11. Reporting Abuse and Copyright

Anyone, including people who are not Users, may report infringing Content to **${C.abuse}** or through the report form on the Zeiko website.

1. **General reports**: include the link or file/Bucket name, the type of violation and supporting evidence if any.
2. **Copyright and DMCA reports**: include the identity of the rights holder or their agent, proof of copyright ownership, the link to the infringing Content, and a statement that the information given is true. Zeiko accepts DMCA-style takedown notices as well as reports under Law No. 28 of 2014 on Copyright. Content reported validly is disabled promptly and handled under Section 6, and a User who believes the report is wrong may file an objection (counter-notice) through Section 8.
3. Complete reports are followed up within **2×24 hours** at most. Reports about Category A are prioritised and handled as fast as possible.
4. False reports or reports made in bad faith may lead to sanctions against the reporter's account.

## 12. Responsibility

**Your responsibility**

1. You are fully legally responsible for all Content you upload, store and share.
2. You agree to hold Zeiko harmless from third-party claims arising from Content or actions of yours that break these terms or the applicable law.

**Limits on Zeiko's responsibility**

1. The Service is provided "as is". Zeiko works to keep data available and secure, but does not guarantee the Service will be free of interruptions or errors.
2. Zeiko is not responsible for data loss, business losses or other indirect losses, including those caused by technical faults, cyber attacks or Credentials leaked on your side.
3. You are strongly advised to always keep a backup of important data somewhere else.
4. For paying Users, Zeiko's total liability is limited to at most the fees you paid in the last 3 months.

## 13. Other Provisions

1. **Changes to the terms.** Zeiko may update these Terms of Service at any time. Important changes are announced by email or in the dashboard at least 7 days before they take effect. Continuing to use the Service after that date means you accept the changes.
2. **Governing law.** These Terms of Service are governed by the laws of the Republic of Indonesia. Disputes are first settled by deliberation, and if no agreement is reached, through the district court in the area of Zeiko's domicile.
3. **Severability.** If any provision is found to be invalid, the other provisions remain fully in force.

**Contact**

- General support and appeals: ${C.support}
- Abuse and copyright reports: ${C.abuse}
- Website: ${C.website}
`;
