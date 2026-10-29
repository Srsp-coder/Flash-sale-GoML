import { prepareTestDatabase } from './database';

export default async function globalSetup(): Promise<void> {
  await prepareTestDatabase();
}
