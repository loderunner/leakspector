/**
 * Example: Database Connection Pool Leak Detection
 *
 * This example demonstrates how to use leakspector to detect
 * database connection pool leaks in your application.
 */

import { track, check, registerPoolAdapter, pgAdapter } from 'leakspector';

// Example 1: Basic usage with pg (PostgreSQL)
async function basicExample() {
  // Import pg dynamically
  const { Pool } = await import('pg');

  // Start tracking with database pool monitoring
  track({ trackers: ['databasePools'] });

  // Create a pool
  const pool = new Pool({
    host: 'localhost',
    database: 'mydb',
    max: 10,
  });

  // Simulate some queries
  const client = await pool.connect();
  await client.query('SELECT 1');

  // GOOD: Release the client back to the pool
  client.release();

  // Check for leaks
  await check(); // Should not throw - no leaks detected
}

// Example 2: Detecting a connection leak
async function leakExample() {
  const { Pool } = await import('pg');

  track({ trackers: ['databasePools'] });

  const pool = new Pool({
    host: 'localhost',
    database: 'mydb',
    max: 10,
  });

  const client = await pool.connect();
  await client.query('SELECT 1');

  // BAD: Forgot to release the client!
  // client.release(); // <-- This line is missing

  try {
    await check();
  } catch (error) {
    console.error('Leak detected!', error.message);
    // Output will show:
    // Database pool leaks detected:
    //   pg#1:
    //     - Active connections grew from 0 to 1 (not released)
    //     - 1 connection(s) remain active and were not released
  }
}

// Example 3: Detecting connections leaked in error handling
async function errorHandlingLeakExample() {
  const { Pool } = await import('pg');

  track({ trackers: ['databasePools'] });

  const pool = new Pool({
    host: 'localhost',
    database: 'mydb',
    max: 10,
  });

  try {
    const client = await pool.connect();
    await client.query('SELECT * FROM non_existent_table');
    // BAD: If query throws, client.release() is never called
    client.release();
  } catch (error) {
    // Error is caught but connection is not released
  }

  try {
    await check();
  } catch (error) {
    console.error('Leak detected!', error.message);
    // This will detect the unreleased connection
  }
}

// Example 4: Using with custom adapters
async function customAdapterExample() {
  // Register only the pg adapter
  registerPoolAdapter(pgAdapter);

  track({ trackers: ['databasePools'], databaseAdapters: [pgAdapter] });

  // Your code here...

  await check();
}

// Example 5: Multiple pools
async function multiplePools() {
  const { Pool } = await import('pg');

  track({ trackers: ['databasePools'] });

  const pool1 = new Pool({ database: 'db1', max: 5 });
  const pool2 = new Pool({ database: 'db2', max: 10 });

  // Pool1: Proper usage
  const client1 = await pool1.connect();
  await client1.query('SELECT 1');
  client1.release();

  // Pool2: Leaked connection
  const client2 = await pool2.connect();
  await client2.query('SELECT 1');
  // Forgot to release client2

  try {
    await check({ format: 'details' });
  } catch (error) {
    console.error('Leaks detected:', error.message);
    // Will show detailed information about pool2's leak
    // including sample history of connection statistics
  }
}

// Example 6: Integration with testing
describe('database operations', () => {
  beforeEach(() => {
    track({ trackers: ['databasePools'] });
  });

  afterEach(async () => {
    await check(); // Will throw if connections are leaked
  });

  it('should properly release connections', async () => {
    const { Pool } = await import('pg');
    const pool = new Pool({ max: 10 });

    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release(); // Important!

    // Test will fail if this is missing
  });
});
