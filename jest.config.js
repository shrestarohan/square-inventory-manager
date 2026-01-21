module.exports = {
  testEnvironment: "node",
  testMatch: ["**/__tests__/**/*.test.js"],
  clearMocks: true,
  restoreMocks: true,
  setupFiles: ["<rootDir>/__tests__/jest.setup.js"],
};
