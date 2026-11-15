import express from "express";
import { errorHandler } from "@/middleware/errorHandler";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { authRateLimit, resetAuthRateLimitForTests } from "@/middleware/authRateLimit";

describe("authRateLimit", () => {
  afterEach(() => resetAuthRateLimitForTests());

  it("blocks repeated attempts by normalized identifier and returns Retry-After", async () => {
    const app = express();
    app.use(express.json());
    app.post("/login", authRateLimit("login"), (_req, res) => res.status(401).end());
    app.use(errorHandler);
    for (let index = 0; index < 10; index += 1) {
      await request(app).post("/login").send({ identifiant: "  PERSON@EXAMPLE.COM " }).expect(401);
    }
    const limited = await request(app).post("/login").send({ identifiant: "person@example.com" }).expect(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
  });
});
