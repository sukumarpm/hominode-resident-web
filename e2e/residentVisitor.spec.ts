import { test, expect } from '@playwright/test';
test.beforeEach(async ({ page }) => {
  await page.route('https://**/*', (route) => route.abort());
});
for (const width of [393, 600, 800, 1440])
  test(`Resident visitor flow fits ${width}px without private or legacy fallback`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/__resident-visitor-test');
    await page.getByRole('button', { name: 'Invite a Visitor', exact: true }).click();
    await page.getByLabel('Visitor name').fill('Offline Guest');
    await page.getByLabel('Purpose').fill('Visit');
    await page.getByLabel('Expected arrival').fill('2099-11-10T08:00');
    await page.getByLabel('Visitor will bring a pet', { exact: true }).check();
    await expect(
      page.getByText('Pets are not permitted for this visit. You may continue without a pet.'),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Invite Visitor', exact: true })).toBeDisabled();
    await page.getByLabel('Visitor will bring a pet', { exact: true }).uncheck();
    await page.getByRole('button', { name: 'Invite Visitor', exact: true }).click();
    await expect(
      page.getByText('Authorization: Pending Admin approval', { exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel('Visitor gate QR code')).toHaveCount(0);
    await page.getByText('Receive synthetic Admin authorization').click();
    await expect(page.getByLabel('Visitor gate QR code')).toBeVisible();
    await expect(page.getByText('ABCD-EFGHJKLM', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Reschedule visitor', exact: true }).click();
    await page.getByLabel('Expected arrival').fill('2099-11-11T09:00');
    await page.getByRole('button', { name: 'Save new visit' }).click();
    await expect(
      page.getByText('Authorization: Pending Admin approval', { exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel('Visitor gate QR code')).toHaveCount(0);
    await page.getByRole('button', { name: 'Cancel invitation' }).click();
    await page.getByRole('button', { name: 'Confirm cancellation' }).click();
    await expect(page.getByText('Authorization: Revoked', { exact: true })).toBeVisible();
    await expect(page.getByText('Visit: Cancelled', { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
test('existing Resident navigation opens the new pet-aware form', async ({ page }) => {
  await page.goto('/green-valley/visitors');
  await page.getByRole('button', { name: 'Invite Visitor', exact: true }).click();
  await expect(page.getByLabel('Visitor will bring a pet', { exact: true })).not.toBeChecked();
});
