// Main journeys: upload → share link downloads directly → trash; plan onboarding; every page renders.
import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

// Signed in once per run by auth.setup.ts (OTP sends are rate-limited like in production).
test.use({ storageState: 'test-results/.auth/demo.json' });

test('upload, share, download, trash', async ({ page, browser }, info) => {
  await page.goto('/drive');
  const name = `e2e-${info.project.name}-${Date.now()}.txt`;
  // The "Baru" inputs upload into the folder on screen, so wait until it has loaded.
  await expect(page.getByRole('navigation', { name: 'Lokasi' })).toContainText('Drive Saya');
  await page
    .locator('input[type="file"][multiple]')
    .first()
    .setInputFiles({
      name,
      mimeType: 'text/plain',
      buffer: Buffer.from('halo dari e2e'),
    });
  const row = page.getByRole('option', { name: new RegExp(name) });
  await expect(row).toBeVisible();

  // Share → the link downloads the file directly (no interstitial, no ad).
  await row.getByRole('button', { name: `Aksi untuk ${name}` }).click();
  await page.getByRole('menuitem', { name: 'Bagikan' }).click();
  const link = await page.getByLabel('Link').inputValue();
  expect(link).toMatch(/^http:\/\/localhost:5173\/[0-9A-Za-z]{64}\/[0-9A-Za-z]{32}\//);
  const anon = await browser.newContext();
  const res = await anon.request.get(link);
  expect(res.status()).toBe(200);
  expect(await res.text()).toBe('halo dari e2e');
  await anon.close();
  await page.keyboard.press('Escape');

  // Trash it, then find it in Sampah.
  await row.getByRole('button', { name: `Aksi untuk ${name}` }).click();
  await page.getByRole('menuitem', { name: 'Pindahkan ke Sampah' }).click();
  await expect(row).toBeHidden();
  await page.goto('/sampah');
  await expect(page.getByText(name)).toBeVisible();
});

test.describe('fresh account', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test('new account without a plan is guided to choose one', async ({ page, request }, info) => {
    test.skip(info.project.name !== 'desktop', 'one OTP sign-in per run is enough');
    await signIn(page, request, 'baru@zeiko.local');
    await expect(page.getByRole('link', { name: 'Buka Paket' }).first()).toBeVisible();
  });
});

test('every main page renders without console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const pages: Array<[string, RegExp]> = [
    ['/terbaru', /Terbaru/],
    ['/berbintang', /Berbintang/],
    ['/dibagikan', /Dibagikan/],
    ['/keluarga', /keluarga/i],
    ['/kompres', /Kompres foto & video/],
    ['/unduhan', /Unduhan/],
    ['/iklan', /Iklan lokal/],
    ['/paket', /Paket & tagihan/],
    ['/pengaturan', /Pengaturan/],
    ['/sampah', /Sampah/],
    ['/kebijakan/kebijakan-iklan', /Kebijakan Iklan/],
  ];
  for (const [path, heading] of pages) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 }).first()).toContainText(heading);
  }
  expect(errors).toEqual([]);
});
