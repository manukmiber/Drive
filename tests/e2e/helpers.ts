// Shared E2E helpers: sign in through the real email-OTP form, reading codes from the dev mailbox.
import { expect, type APIRequestContext, type Page } from '@playwright/test';

export const API = 'http://127.0.0.1:8790';

export async function otpFor(request: APIRequestContext, email: string): Promise<string> {
  for (let i = 0; i < 30; i++) {
    const res = await request.get(`${API}/__dev/mail`);
    const { mails } = (await res.json()) as { mails: Array<{ to: string[]; subject: string }> };
    const m = mails.find((x) => x.to.includes(email) && /\d{6}/.test(x.subject));
    if (m) return /(\d{6})/.exec(m.subject)![1]!;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('no OTP mail');
}

export async function signIn(page: Page, request: APIRequestContext, email: string) {
  await page.goto('/masuk');
  await page.getByPlaceholder('nama@contoh.com').fill(email);
  // Older codes for the same address may still be in the dev mailbox: wait for a new one.
  const before = ((await (await request.get(`${API}/__dev/mail`)).json()) as { mails: unknown[] })
    .mails.length;
  await page.getByRole('button', { name: 'Kirim kode' }).click();
  await expect
    .poll(
      async () =>
        ((await (await request.get(`${API}/__dev/mail`)).json()) as { mails: unknown[] }).mails
          .length,
    )
    .toBeGreaterThan(before);
  await page.locator('input[inputmode="numeric"]').fill(await otpFor(request, email));
  await page.getByRole('button', { name: 'Masuk', exact: true }).click();
  await expect(page).toHaveURL(/\/drive/);
}
