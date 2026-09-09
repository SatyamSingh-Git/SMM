import { describe, expect, it } from "vitest";
import { encryptToken, decryptToken } from "./crypto.js";

describe("token encryption", () => {
  it("round-trips a token", () => {
    const token = "EAAG1234567890abcdefLONGLIVEDTOKEN";
    expect(decryptToken(encryptToken(token))).toBe(token);
  });

  it("round-trips unicode", () => {
    const token = "काम करता है 🔐";
    expect(decryptToken(encryptToken(token))).toBe(token);
  });

  it("produces a different ciphertext each time (random IV)", () => {
    const token = "same-plaintext";
    expect(encryptToken(token)).not.toBe(encryptToken(token));
  });

  // The whole point of GCM over CBC: a modified payload fails loudly instead of
  // decrypting to garbage that we'd then send to Meta as an access token.
  it("throws on a tampered payload rather than returning garbage", () => {
    const buf = Buffer.from(encryptToken("secret"), "base64");
    buf[buf.length - 1]! ^= 0xff; // flip bits in the auth tag
    expect(() => decryptToken(buf.toString("base64"))).toThrow();
  });

  it("throws when the ciphertext body is tampered with", () => {
    const buf = Buffer.from(encryptToken("secret"), "base64");
    buf[13]! ^= 0xff; // inside the ciphertext, past the 12-byte IV
    expect(() => decryptToken(buf.toString("base64"))).toThrow();
  });

  it("rejects a payload too short to hold iv + tag", () => {
    expect(() => decryptToken(Buffer.alloc(20).toString("base64"))).toThrow(
      /too short/i
    );
  });
});
