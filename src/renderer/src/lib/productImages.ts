import { supabase } from "./supabase";
import { uuid } from "./uuid";

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
};

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Uploads a product (or variant) image to the shared `product-images`
 * bucket under the store's folder and returns its public URL — the same
 * path layout and size limit Fiche Produit has always used, now shared
 * with the variant dialog instead of duplicated.
 */
export async function uploadProductImage(
  storeId: string,
  file: File,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
  const isImage = file.type.startsWith("image/") || ext in IMAGE_MIME_BY_EXT;
  if (!isImage) return { ok: false, error: "لازم تختار صورة." };
  if (file.size > MAX_IMAGE_BYTES) return { ok: false, error: "الصورة كبيرة برشا (أقصى 5 ميغا)." };
  const path = `${storeId}/${uuid()}.${ext}`;
  const { error } = await supabase.storage
    .from("product-images")
    .upload(path, file, { upsert: true, contentType: file.type || IMAGE_MIME_BY_EXT[ext] || "application/octet-stream" });
  if (error) return { ok: false, error: error.message || "ما قدرناش نرفعو الصورة." };
  const { data } = supabase.storage.from("product-images").getPublicUrl(path);
  return { ok: true, url: data.publicUrl };
}
