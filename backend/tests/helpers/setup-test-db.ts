import { prepareTestDatabase } from './database';

prepareTestDatabase()
  .then(() => console.log('[test-db] migrated, seeded and reset (500 units)'))
  .catch((error) => {
    console.error('[test-db] setup failed', error);
    process.exitCode = 1;
  });
