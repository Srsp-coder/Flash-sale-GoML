import { closeTestConnections } from './database';

export default async function globalTeardown(): Promise<void> {
  await closeTestConnections();
}
