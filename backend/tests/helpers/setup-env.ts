import { configureTestEnv } from './test-env';

// Runs before any test module is imported, so `src/config` sees the test
// database, Redis DB 15 and the isolated `flashsale_test` queue namespace.
configureTestEnv();
