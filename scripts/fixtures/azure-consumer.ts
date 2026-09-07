import { strict as assert } from 'node:assert';
import type { TokenCredential } from '@azure/core-auth';
import { createAzureStorageDriver } from '@nestm/storage/files-sdk/azure';

const credential: TokenCredential = {
  getToken: async () => ({
    token: 'test',
    expiresOnTimestamp: Date.now() + 60000,
  }),
};
const driver = createAzureStorageDriver({
  adapter: { accountName: 'nestmtest', container: 'content', credential },
});
assert.equal(driver.capabilities?.conditionalCreate?.resultEtag, true);
assert.equal(driver.capabilities?.conditionalRead?.etag, true);
assert.equal(driver.capabilities?.conditionalDelete?.etag, true);
