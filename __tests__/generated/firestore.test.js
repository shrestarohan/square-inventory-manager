/* eslint-env jest */

describe('lib/firestore', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    // Ensure a clean module cache and copy env for safe mutation
    jest.resetModules();
    process.env = { ...OLD_ENV };
  });

  afterEach(() => {
    // Restore original environment and any mocked spies
    process.env = OLD_ENV;
    jest.restoreAllMocks();
  });

  test('uses DEFAULT database when FIRESTORE_DATABASE_ID not set', () => {
    // Ensure env var is not present
    delete process.env.FIRESTORE_DATABASE_ID;

    // Prepare a mock Firestore constructor that records the options it was called with
    const FirestoreMock = jest.fn((opts) => ({ __mockFirestore: true, opts }));

    // Mock the @google-cloud/firestore module before requiring the module under test
    jest.doMock('@google-cloud/firestore', () => ({ Firestore: FirestoreMock }));

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    // Require the module after mocking
    const firestore = require('../../lib/firestore');

    // Assert the mocked constructor was invoked once with empty options
    expect(FirestoreMock).toHaveBeenCalledTimes(1);
    expect(FirestoreMock).toHaveBeenCalledWith({});

    // The module should export the instance returned by our mock
    expect(firestore).toHaveProperty('__mockFirestore', true);
    expect(firestore.opts).toEqual({});

    // Should have logged the DEFAULT message
    expect(logSpy).toHaveBeenCalledWith('🔥 Using Firestore DEFAULT database');
  });

  test('uses FIRESTORE_DATABASE_ID when set', () => {
    process.env.FIRESTORE_DATABASE_ID = 'my-db-123';

    const FirestoreMock = jest.fn((opts) => ({ __mockFirestore: true, opts }));
    jest.doMock('@google-cloud/firestore', () => ({ Firestore: FirestoreMock }));

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const firestore = require('../../lib/firestore');

    // Expect Firestore to be constructed with databaseId option
    expect(FirestoreMock).toHaveBeenCalledTimes(1);
    expect(FirestoreMock).toHaveBeenCalledWith({ databaseId: 'my-db-123' });

    expect(firestore).toHaveProperty('__mockFirestore', true);
    expect(firestore.opts).toEqual({ databaseId: 'my-db-123' });

    // The module logs the database id as a second argument
    expect(logSpy).toHaveBeenCalledWith('🔥 Using Firestore database:', 'my-db-123');
  });
});
