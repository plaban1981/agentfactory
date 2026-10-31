import "server-only";

import { randomUUID } from "node:crypto";
import { MAX_LOGO_BYTES } from "@/lib/workspace-limits";

export type LogoFile = { bytes: Uint8Array; type: string; ext: string };

// Detect the image type from its bytes; the browser-supplied MIME type is not trusted.
// SVG is deliberately excluded: it can carry scripts.
function sniffImage(bytes: Uint8Array): { type: string; ext: string } | null {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (bytes[0] === 0x89 && ascii(1, 4) === "PNG") return { type: "image/png", ext: "png" };
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { type: "image/jpeg", ext: "jpg" };
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return { type: "image/webp", ext: "webp" };
  return null;
}

// Validates an uploaded workspace logo. `file` is null when nothing was uploaded.
export async function readLogoUpload(value: FormDataEntryValue | null): Promise<{ file: LogoFile | null } | { error: string }> {
  if (!(value instanceof File) || value.size === 0) return { file: null };
  if (value.size > MAX_LOGO_BYTES) return { error: "Logo must be 1 MB or smaller." };
  const bytes = new Uint8Array(await value.arrayBuffer());
  const kind = sniffImage(bytes);
  if (!kind) return { error: "Logo must be a PNG, JPG or WebP image." };
  return { file: { bytes, ...kind } };
}

export function logoObjectKey(workspaceId: string, ext: string) {
  return `workspaces/${workspaceId}/logo-${randomUUID()}.${ext}`;
}
