const request = require("supertest");
const app = require("../app");

describe("Sanity: server boots", () => {
  test("GET /healthz returns 200", async () => {
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/ok/i);
  });
});
