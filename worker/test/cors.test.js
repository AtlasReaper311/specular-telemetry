import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/index.js";

const env = {
  ALLOWED_ORIGINS:
    "https://atlas-systems.uk,https://www.atlas-systems.uk,https://status.atlas-systems.uk,http://localhost:8788",
};

test("specular-edge permits the public Status surface", async () => {
  const response = await worker.fetch(
    new Request("https://api.atlas-systems.uk/specular", {
      method: "OPTIONS",
      headers: { origin: "https://status.atlas-systems.uk" },
    }),
    env,
    {},
  );

  assert.equal(response.status, 204);
  assert.equal(
    response.headers.get("access-control-allow-origin"),
    "https://status.atlas-systems.uk",
  );
  assert.equal(response.headers.get("vary"), "origin");
});

test("specular-edge does not reflect an unapproved origin", async () => {
  const response = await worker.fetch(
    new Request("https://api.atlas-systems.uk/specular", {
      method: "OPTIONS",
      headers: { origin: "https://example.invalid" },
    }),
    env,
    {},
  );

  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.equal(response.headers.get("vary"), "origin");
});
