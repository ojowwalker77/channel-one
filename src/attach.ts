// Loading local image files into message attachments. Bun/Node only: reads
// from disk, so the web app and the Worker never import this.

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { MAX_IMAGE_BYTES, MAX_IMAGES, type ImageAttachment } from "./protocol.ts";

export type { ImageAttachment };

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function kb(n: number): string {
  return n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)}MB` : `${Math.round(n / 1024)}KB`;
}

/** Read image files into attachments. Throws a plain Error naming the problem. */
export function loadImages(paths: string[]): ImageAttachment[] {
  if (paths.length > MAX_IMAGES) throw new Error(`at most ${MAX_IMAGES} images per message`);
  return paths.map((p) => {
    if (!existsSync(p)) throw new Error(`no such image: ${p}`);
    if (!statSync(p).isFile()) throw new Error(`not a file: ${p}`);
    const mime = MIME[extname(p).toLowerCase()];
    if (!mime) throw new Error(`${p}: image must be png, jpg, gif or webp`);
    const raw = readFileSync(p);
    if (raw.length > MAX_IMAGE_BYTES) {
      throw new Error(`${p} is ${kb(raw.length)} (limit ${kb(MAX_IMAGE_BYTES)}); shrink or convert it to jpeg first`);
    }
    return { name: basename(p), mime, data: raw.toString("base64") };
  });
}
