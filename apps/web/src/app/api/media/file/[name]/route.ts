import { readFile } from "node:fs/promises";
import path from "node:path";
import { fail } from "@/lib/respond";

type Params = { params: Promise<{ name: string }> };

/** Serves local-driver uploads in dev. Prod serves from CloudFront/S3 instead. */
export async function GET(_req: Request, { params }: Params) {
  const { name } = await params;
  const safe = path.basename(name); // no traversal
  const file = path.join(process.cwd(), ".data", "uploads", safe);
  try {
    const buf = await readFile(file);
    const ext = path.extname(safe).slice(1);
    const type =
      {
        jpg: "image/jpeg",
        png: "image/png",
        webp: "image/webp",
        mp3: "audio/mpeg",
        m4a: "audio/mp4",
      }[ext] ?? "application/octet-stream";
    return new Response(new Uint8Array(buf), {
      headers: { "content-type": type, "cache-control": "public, max-age=3600" },
    });
  } catch {
    return fail("not_found", "We couldn't find that file.", 404);
  }
}
