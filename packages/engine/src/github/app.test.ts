import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { GithubAppAuth, appConfigured } from "./app.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

function decodeJwt(jwt: string): { header: unknown; payload: unknown; signature: string; signingInput: string } {
  const parts = jwt.split(".");
  assert.equal(parts.length, 3, "JWT has three parts");
  const [h, p, s] = parts as [string, string, string];
  const header = JSON.parse(Buffer.from(h, "base64").toString("utf8"));
  const payload = JSON.parse(Buffer.from(p, "base64").toString("utf8"));
  return { header, payload, signature: s, signingInput: `${h}.${p}` };
}

describe("appConfigured", () => {
  it("returns true only when all three env vars are set", () => {
    assert.equal(
      appConfigured({
        MINIONS_GH_APP_ID: "1",
        MINIONS_GH_APP_PRIVATE_KEY: "key",
        MINIONS_GH_APP_INSTALLATION_ID: "2",
      }),
      true,
    );
    assert.equal(
      appConfigured({
        MINIONS_GH_APP_ID: "1",
        MINIONS_GH_APP_INSTALLATION_ID: "2",
      }),
      false,
    );
    assert.equal(appConfigured({}), false);
  });
});

describe("GithubAppAuth.mintJwt", () => {
  it("produces a JWT signed with RS256 that verifies against the public key", () => {
    const auth = new GithubAppAuth({ appId: "12345", privateKey, installationId: "99" });
    const now = 1_700_000_000;
    const jwt = auth.mintJwt(now);
    const { header, payload, signature, signingInput } = decodeJwt(jwt);

    assert.deepEqual(header, { alg: "RS256", typ: "JWT" });
    assert.deepEqual(payload, { iat: now - 60, exp: now + 9 * 60, iss: "12345" });

    const sigBuf = Buffer.from(
      signature.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(signature.length / 4) * 4, "="),
      "base64",
    );
    const verifier = createVerify("RSA-SHA256");
    verifier.update(signingInput);
    verifier.end();
    assert.equal(verifier.verify(publicKey, sigBuf), true);
  });
});
