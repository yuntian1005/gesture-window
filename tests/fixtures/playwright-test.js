import { expect, test as base } from '@playwright/test';

export function isAllowedRequest(url, previewOrigin) {
  const parsed = new URL(url);
  if (['about:', 'blob:', 'data:'].includes(parsed.protocol)) return true;
  return parsed.origin === previewOrigin;
}

export const test = base.extend({
  offlineGate: [async ({ baseURL, context }, use) => {
    const previewOrigin = new URL(baseURL).origin;
    const externalRequests = [];
    await context.route('**/*', async (route) => {
      const request = route.request();
      if (isAllowedRequest(request.url(), previewOrigin)) {
        await route.continue();
        return;
      }
      externalRequests.push({
        method: request.method(),
        resourceType: request.resourceType(),
        url: request.url(),
      });
      await route.abort('blockedbyclient');
    });
    await use(externalRequests);
    expect(externalRequests, 'E2E must not request external resources').toEqual([]);
  }, { auto: true }],
});

export { expect } from '@playwright/test';
