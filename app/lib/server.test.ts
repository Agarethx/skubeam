import { describe, it, expect } from "vitest";
import { safeRedirect } from "./server";

describe("safeRedirect", () => {
  it("appends shop and host params to the redirect path", () => {
    const req = new Request(
      "https://app.example.com/app?shop=test.myshopify.com&host=abc123",
    );
    const res = safeRedirect(req, "/app/skus");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "/app/skus?shop=test.myshopify.com&host=abc123",
    );
  });

  it("redirects to bare path when no shop/host params are present", () => {
    const req = new Request("https://app.example.com/app");
    const res = safeRedirect(req, "/app/skus");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/app/skus");
  });
});
