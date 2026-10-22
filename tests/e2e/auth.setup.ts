// Signs in the demo user once through the real OTP form and stores the session for the other tests.
import { test as setup } from '@playwright/test';
import { signIn } from './helpers';

setup('sign in as demo', async ({ page, request }) => {
  await signIn(page, request, 'demo@zeiko.local');
  await page.context().storageState({ path: 'test-results/.auth/demo.json' });
});
