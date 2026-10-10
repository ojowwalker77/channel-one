// Loading local image files into message attachments. Bun/Node only: reads
// from disk, so the web app and the Worker never import this.

import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { home } from "./config.ts";
import { MAX_IMAGE_BYTES, MAX_IMAGES, type ImageAttachment, type RasterMime } from "./protocol.ts";

export type { ImageAttachment };

const MIME: Record<string, RasterMime> = {
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

/** True when `child` is `parent` or a directory inside it, by path spelling (the directory may not exist yet). */
function inside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** chmod `dir` and each parent up through `root`. Stops at `root`. Skips anything that isn't a real directory. */
function lockDirs(dir: string, root: string): void {
  const top = resolve(root);
  for (let cur = resolve(dir); ; ) {
    if (cur !== top && !inside(top, cur)) break;
    try {
      if (lstatSync(cur).isDirectory()) chmodSync(cur, 0o700);
    } catch {}
    if (cur === top || dirname(cur) === cur) break;
    cur = dirname(cur);
  }
}

/** Write message #seq's images into `dir` as `#<seq>-<name>`; returns the paths. Files are 0600. Directories under ~/.kiwi/downloads are 0700; a directory the caller named keeps its own mode. */
export function saveImages(seq: number, imgs: ImageAttachment[], dir: string): string[] {
  const downloads = join(home(), "downloads");
  const locked = inside(downloads, dir);
  mkdirSync(dir, locked ? { recursive: true, mode: 0o700 } : { recursive: true });
  if (locked) lockDirs(dir, downloads);
  return imgs.map((img) => {
    const safe = img.name.replace(/[^A-Za-z0-9_.-]/g, "_") || "image";
    const path = join(dir, `#${seq}-${safe}`);
    writeFileSync(path, Buffer.from(img.data, "base64"), { mode: 0o600 });
    try {
      chmodSync(path, 0o600);
    } catch {}
    return path;
  });
}
