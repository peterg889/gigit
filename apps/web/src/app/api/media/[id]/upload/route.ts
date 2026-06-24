import { db, schema } from "@gigit/db";
import { eq } from "drizzle-orm";
import { requireUser, respondError } from "@/lib/auth";
import { fail, ok } from "@/lib/respond";
import { AUDIO_MAX_BYTES, IMAGE_MAX_BYTES, localWrite } from "@/lib/storage";

type Params = { params: Promise<{ id: string }> };

/** Local-driver upload sink (dev). With STORAGE_DRIVER=s3 the client PUTs to S3 instead. */
export async function PUT(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const userId = await requireUser();
    const d = db();
    const [asset] = await d
      .select()
      .from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.id, id));
    if (!asset || asset.ownerUserId !== userId)
      return fail("not_found", "media not found", 404);
    if (asset.status !== "uploaded")
      return fail("conflict", `asset is ${asset.status}`, 409);

    const buf = Buffer.from(await req.arrayBuffer());
    const max = asset.kind === "audio" ? AUDIO_MAX_BYTES : IMAGE_MAX_BYTES;
    if (buf.byteLength === 0 || buf.byteLength > max)
      return fail("too_large", "invalid upload size", 422);
    await localWrite(asset.storageKey!, buf);
    // Stay 'uploaded': complete() is the single place that advances to
    // 'processing' and requests screening — identical for the local and S3 paths.
    await d
      .update(schema.mediaAssets)
      .set({ bytes: buf.byteLength })
      .where(eq(schema.mediaAssets.id, id));
    return ok({ id, status: "uploaded" });
  } catch (e) {
    return respondError(e);
  }
}
