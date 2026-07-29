import { describe, expect, it, vi } from "vitest";

vi.mock("@gigit/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@gigit/db")>();
  return {
    ...actual,
    env: () => ({
      ...actual.env(),
      STORAGE_DRIVER: "s3",
      S3_BUCKET: "test-bucket",
      AWS_REGION: "us-east-1",
      AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
      AWS_SECRET_ACCESS_KEY: "x".repeat(40),
    }),
  };
});

process.env.AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
process.env.AWS_SECRET_ACCESS_KEY = "x".repeat(40);
process.env.AWS_REGION = "us-east-1";

const { uploadTargetFor } = await import("./storage");

/**
 * The upload grant used to cover bucket + key + expiry only, so the size the
 * client declared at presign time was advisory — declare 1 byte, PUT 5 GiB, and
 * nothing downstream reconciled it (the row kept the declared size and the
 * worker read the whole object into memory). Signing content-length makes S3
 * itself reject a body of any other length; confirmed against the real bucket,
 * where an oversize PUT against a length-signed grant returns 403.
 */
describe("presigned upload grant", () => {
  it("signs content-length so the declared size is the only size that works", async () => {
    const target = await uploadTargetFor("med_abc", "image/jpeg", 12_345);
    const params = new URL(target.uploadUrl).searchParams;

    expect(params.get("X-Amz-SignedHeaders")).toBe("content-length;host");
    expect(target.headers?.["content-length"]).toBe("12345");
  });

  it("does not sign a checksum of a body it doesn't have", async () => {
    // The SDK default (WHEN_SUPPORTED) hoists a CRC32 of the EMPTY body into
    // the signed query string, where a client can't correct it. S3 tolerates it
    // today, but signing a checksum of a body we never saw buys nothing.
    const target = await uploadTargetFor("med_abc", "audio/mpeg", 999);
    const params = new URL(target.uploadUrl).searchParams;

    expect(params.get("x-amz-checksum-crc32")).toBeNull();
    expect(params.get("x-amz-sdk-checksum-algorithm")).toBeNull();
  });

  it("keeps the size out of the key and off the local driver's path", async () => {
    const target = await uploadTargetFor("med_xyz", "image/png", 42);
    expect(target.storageKey).toBe("media/med_xyz.png");
    expect(target.method).toBe("PUT");
  });
});
