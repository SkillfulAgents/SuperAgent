import { test, expect } from '@playwright/test'

const passed = { valid: true, checks: [
  { label: 'List objects', status: 'passed' }, { label: 'Create and overwrite objects', status: 'passed' },
  { label: 'Read objects', status: 'passed' }, { label: 'Protect concurrent edits', status: 'passed' },
  { label: 'Copy objects (rename)', status: 'passed' }, { label: 'Upload large files', status: 'passed' },
  { label: 'Cancel unfinished uploads', status: 'passed' }, { label: 'Delete objects', status: 'passed' },
], warnings: [] }

test('S3 setup explains missing privileges, rechecks edits, and creates a validated private or public volume', async ({ page }) => {
  let valid = false
  const bodies: unknown[] = []
  await page.route('**/api/volume-types/s3/validate', route => route.fulfill({ json: valid ? passed : {
    valid: false, checks: [...passed.checks.slice(0, -1), { label: 'Delete objects', status: 'failed', message: 'This key cannot delete objects. Grant s3:DeleteObject or R2 Object Read & Write access.' }],
    warnings: ['Could not remove test object: shared/.gamut-check-example/object. Remove it after fixing delete permissions.'],
  } }))
  await page.route('**/api/volume-definitions', async route => {
    if (route.request().method() !== 'POST') return route.continue()
    bodies.push(route.request().postDataJSON())
    return route.fulfill({ status: 201, json: { id: 's3-e2e-volume' } })
  })
  await page.goto('/settings/volumes')
  await page.getByRole('button', { name: 'Add drive', exact: true }).click()
  await page.getByRole('button', { name: 'S3-compatible bucket', exact: true }).click()
  await page.getByLabel('Endpoint URL').fill('https://example.r2.cloudflarestorage.com')
  await expect(page.getByLabel('Region')).toHaveValue('auto')
  await page.getByLabel('Bucket', { exact: true }).fill('example-bucket')
  await page.getByLabel('Access key ID').fill('test-access-key')
  await page.getByLabel('Secret access key').fill('test-secret')
  await page.getByLabel('Folder prefix (optional)').fill('shared')
  await page.getByRole('button', { name: 'Test connection', exact: true }).click()
  await expect(page.getByTestId('s3-validation-result')).toContainText('Grant s3:DeleteObject')
  await expect(page.getByTestId('s3-validation-result')).toContainText('Could not remove test object')
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toHaveCount(0)
  valid = true
  await page.getByLabel('Secret access key').fill('fixed-test-secret')
  await expect(page.getByTestId('s3-validation-result')).toHaveCount(0)
  await page.getByRole('button', { name: 'Test connection', exact: true }).click()
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('shared')
  await page.getByRole('button', { name: 'Create drive', exact: true }).click()
  await expect(page.getByTestId('volume-settings-dialog')).toHaveCount(0)
  expect(bodies).toEqual([expect.objectContaining({ name: 'shared', type: 's3', config: expect.objectContaining({ bucket: 'example-bucket', prefix: 'shared', region: 'auto' }) })])
})
