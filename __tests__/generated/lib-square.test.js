// __tests__/generated/lib-square.test.js

// Mock the square/legacy module BEFORE requiring the module under test
jest.mock("square/legacy", () => {
  const Client = jest.fn(function (opts) {
    // capture options on the created instance for assertions if needed
    this._opts = opts;
    return this;
  });

  const Environment = {
    Sandbox: "ENV_SANDBOX",
    Production: "ENV_PRODUCTION",
  };

  return { Client, Environment };
});

const { Client, Environment } = require("square/legacy");
const sq = require("../../lib/square");

describe("lib/square", () => {
  beforeEach(() => {
    // Clear mocks and env between tests
    jest.clearAllMocks();
    delete process.env.SQUARE_ENV;
  });

  describe("createSquareOAuthClient", () => {
    test("uses sandbox environment when requested (case-insensitive)", () => {
      sq.createSquareOAuthClient("SANDBOX");
      expect(Client).toHaveBeenCalledTimes(1);
      expect(Client).toHaveBeenCalledWith({ environment: Environment.Sandbox });
    });

    test("defaults to production for unknown envs", () => {
      sq.createSquareOAuthClient("something-else");
      expect(Client).toHaveBeenCalledTimes(1);
      expect(Client).toHaveBeenCalledWith({ environment: Environment.Production });
    });
  });

  describe("createSquareClient", () => {
    test("passes bearerAuthCredentials and uses sandbox when provided", () => {
      sq.createSquareClient("tok_123", "sandbox");
      expect(Client).toHaveBeenCalledTimes(1);
      expect(Client).toHaveBeenCalledWith({
        environment: Environment.Sandbox,
        bearerAuthCredentials: { accessToken: "tok_123" },
      });
    });

    test("defaults env to production when omitted", () => {
      sq.createSquareClient("tok_321");
      expect(Client).toHaveBeenCalledTimes(1);
      expect(Client).toHaveBeenCalledWith({
        environment: Environment.Production,
        bearerAuthCredentials: { accessToken: "tok_321" },
      });
    });
  });

  describe("squareBaseUrl", () => {
    test("returns sandbox base url by default", () => {
      const url = sq.squareBaseUrl();
      expect(url).toBe("https://connect.squareupsandbox.com");
    });

    test("returns production base url when normalized env is production", () => {
      expect(sq.squareBaseUrl("production")).toBe("https://connect.squareup.com");
      expect(sq.squareBaseUrl("PRODUCTION")).toBe("https://connect.squareup.com");
    });
  });

  describe("makeCreateSquareClientForMerchant", () => {
    test("throws if firestore is not provided", () => {
      expect(() => sq.makeCreateSquareClientForMerchant({})).toThrow(
        "makeCreateSquareClientForMerchant requires firestore"
      );
    });

    test("throws if merchant not found", async () => {
      const firestore = {
        collection: () => ({
          doc: () => ({
            get: async () => ({ exists: false }),
          }),
        }),
      };
      const make = sq.makeCreateSquareClientForMerchant({ firestore });
      await expect(make({ merchantId: "m1" })).rejects.toThrow("Merchant not found: m1");
    });

    test("throws if merchant has no access token", async () => {
      const firestore = {
        collection: () => ({
          doc: () => ({
            get: async () => ({ exists: true, data: () => ({}) }),
          }),
        }),
      };
      const make = sq.makeCreateSquareClientForMerchant({ firestore });
      await expect(make({ merchantId: "m2" })).rejects.toThrow(
        "Missing Square access token for merchant m2"
      );
    });

    test("prefers various token field names and calls createSquareClient with correct args", async () => {
      // We'll spy on the exported createSquareClient so we can assert it was called
      const mod = require("../../lib/square");
      const spy = jest.spyOn(mod, "createSquareClient");

      const tokenVariants = [
        { obj: { square_access_token: "t1" }, want: "t1" },
        { obj: { access_token: "t2" }, want: "t2" },
        { obj: { accessToken: "t3" }, want: "t3" },
        { obj: { squareAccessToken: "t4" }, want: "t4" },
        { obj: { square: { access_token: "t5" } }, want: "t5" },
      ];

      let idx = 0;
      for (const v of tokenVariants) {
        idx += 1;
        const firestore = {
          collection: () => ({
            doc: () => ({
              get: async () => ({ exists: true, data: () => v.obj }),
            }),
          }),
        };
        const make = sq.makeCreateSquareClientForMerchant({ firestore });
        await make({ merchantId: `m-${idx}` });
        expect(spy).toHaveBeenLastCalledWith(v.want, expect.any(String));
      }

      spy.mockRestore();
    });

    test("resolves env from merchant fields and falls back to process.env.SQUARE_ENV then production", async () => {
      const mod = require("../../lib/square");
      const spy = jest.spyOn(mod, "createSquareClient");

      // Case 1: merchant has square_env
      const fs1 = {
        collection: () => ({
          doc: () => ({
            get: async () => ({ exists: true, data: () => ({ square_access_token: "tt1", square_env: "sandbox" }) }),
          }),
        }),
      };
      await sq.makeCreateSquareClientForMerchant({ firestore: fs1 })({ merchantId: "a" });
      expect(spy).toHaveBeenLastCalledWith("tt1", "sandbox");

      // Case 2: merchant has env
      const fs2 = {
        collection: () => ({
          doc: () => ({
            get: async () => ({ exists: true, data: () => ({ square_access_token: "tt2", env: "production" }) }),
          }),
        }),
      };
      await sq.makeCreateSquareClientForMerchant({ firestore: fs2 })({ merchantId: "b" });
      expect(spy).toHaveBeenLastCalledWith("tt2", "production");

      // Case 3: merchant has nested square.env
      const fs3 = {
        collection: () => ({
          doc: () => ({
            get: async () => ({ exists: true, data: () => ({ square_access_token: "tt3", square: { env: "sandbox" } }) }),
          }),
        }),
      };
      await sq.makeCreateSquareClientForMerchant({ firestore: fs3 })({ merchantId: "c" });
      expect(spy).toHaveBeenLastCalledWith("tt3", "sandbox");

      // Case 4: fallback to process.env.SQUARE_ENV
      process.env.SQUARE_ENV = "sandbox";
      const fs4 = {
        collection: () => ({
          doc: () => ({
            get: async () => ({ exists: true, data: () => ({ square_access_token: "tt4" }) }),
          }),
        }),
      };
      await sq.makeCreateSquareClientForMerchant({ firestore: fs4 })({ merchantId: "d" });
      expect(spy).toHaveBeenLastCalledWith("tt4", "sandbox");

      // Case 5: fallback to production when nothing set
      delete process.env.SQUARE_ENV;
      const fs5 = {
        collection: () => ({
          doc: () => ({
            get: async () => ({ exists: true, data: () => ({ square_access_token: "tt5" }) }),
          }),
        }),
      };
      await sq.makeCreateSquareClientForMerchant({ firestore: fs5 })({ merchantId: "e" });
      expect(spy).toHaveBeenLastCalledWith("tt5", "production");

      spy.mockRestore();
    });

    test("returned function creates a square client instance (calls createSquareClient which constructs Client)", async () => {
      // Ensure integration: when createSquareClient is called it will in turn call the mocked Client constructor
      const mod = require("../../lib/square");
      const spy = jest.spyOn(mod, "createSquareClient");

      const firestore = {
        collection: () => ({
          doc: () => ({
            get: async () => ({ exists: true, data: () => ({ access_token: "int-token", square_env: "sandbox" }) }),
          }),
        }),
      };

      const make = sq.makeCreateSquareClientForMerchant({ firestore });
      await make({ merchantId: "int" });

      // createSquareClient should have been called with token and env
      expect(spy).toHaveBeenCalledWith("int-token", "sandbox");

      // And the Client constructor should have been called (one for createSquareClient)
      expect(Client).toHaveBeenCalled();

      spy.mockRestore();
    });
  });
});
