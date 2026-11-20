import test from "node:test";
import assert from "node:assert/strict";
import { onRequestPost } from "../functions/api/mpesa-callback.js";

function context(secret, token) {
  const url = new URL("https://example.test/api/mpesa-callback");
  if (token !== undefined) url.searchParams.set("token", token);
  return {
    request: new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ Body: { stkCallback: { CheckoutRequestID: "unknown" } } }) }),
    env: { ...(secret === undefined ? {} : { MPESA_CALLBACK_SECRET: secret }), DB: { prepare() { throw Error("Database must not be reached for unauthorized requests"); } } }
  };
}
test("rejects callbacks when the secret is not configured", async () => {
  const res = await onRequestPost(context(undefined, "anything"));
  assert.equal(res.status, 503);
});
test("rejects callbacks when the secret is empty", async () => {
  const res = await onRequestPost(context("", "anything"));
  assert.equal(res.status, 503);
});
test("rejects missing and incorrect tokens", async () => {
  for (const token of [undefined, "wrong"]) {
    const res = await onRequestPost(context("expected", token));
    assert.equal(res.status, 401);
  }
});
test("accepts an authenticated callback into normal processing", async () => {
  const res = await onRequestPost(context("expected", "expected"));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ResultDesc, "Transaction not tracked");
});
