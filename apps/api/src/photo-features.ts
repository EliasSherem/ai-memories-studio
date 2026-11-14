import sharp from 'sharp';
import exifr from 'exifr';
import type { ExifEvidence, LocalPhotoFeatures } from '@memories/shared';
import { ApiError } from './errors.js';

const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim().slice(0, 250) : null;
export function metadataEvidence(exif: Record<string, unknown> | undefined, googleMetadata: Record<string, unknown>[] = []): ExifEvidence {
  const original = text(exif?.DateTimeOriginal);
  const offset = text(exif?.OffsetTimeOriginal);
  const googleDate = googleMetadata.map(value => text(value.createTime)).find(Boolean) ?? null;
  const latitude = typeof exif?.latitude === 'number' && Number.isFinite(exif.latitude) && Math.abs(exif.latitude) <= 90 ? exif.latitude : null;
  const longitude = typeof exif?.longitude === 'number' && Number.isFinite(exif.longitude) && Math.abs(exif.longitude) <= 180 ? exif.longitude : null;
  return { dateTimeOriginal: original ? `${original}${offset ? ` ${offset}` : ''}` : googleDate, dateSource: original ? 'EXIF' : googleDate ? 'GOOGLE_METADATA' : 'NONE', latitude, longitude, locationSource: latitude !== null && longitude !== null ? 'EXIF' : 'NONE', cameraMake: text(exif?.Make), cameraModel: text(exif?.Model) };
}
export function hammingDistance(a: string, b: string): number {
  if (!/^[a-f0-9]{16}$/i.test(a) || !/^[a-f0-9]{16}$/i.test(b)) return 64;
  let bits = BigInt(`0x${a}`) ^ BigInt(`0x${b}`), count = 0;
  while (bits) { bits &= bits - 1n; count++; }
  return count;
}
export async function extractPhotoFeatures(file: string, sha256: string, googleMetadata: Record<string, unknown>[] = []): Promise<LocalPhotoFeatures> {
  try {
    // Rotate first so EXIF-oriented originals have consistent perceptual hashes.
    const image = sharp(file, { limitInputPixels: 100_000_000, failOn: 'error' }).rotate();
    const metadata = await image.metadata();
    const pixels = await image.clone().resize(9, 8, { fit: 'fill' }).greyscale().removeAlpha().raw().toBuffer();
    let hash = 0n;
    for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) hash = (hash << 1n) | (pixels[row * 9 + col] > pixels[row * 9 + col + 1] ? 1n : 0n);
    let exif: Record<string, unknown> | undefined;
    try { exif = await exifr.parse(file, { reviveValues: false, pick: ['DateTimeOriginal', 'OffsetTimeOriginal', 'Make', 'Model', 'GPSLatitude', 'GPSLongitude', 'GPSLatitudeRef', 'GPSLongitudeRef'] }) as Record<string, unknown> | undefined; } catch { /* Missing/malformed EXIF is not invented. */ }
    const swapped = [5, 6, 7, 8].includes(metadata.orientation ?? 1);
    return { sha256, perceptualHash: hash.toString(16).padStart(16, '0'), width: (swapped ? metadata.height : metadata.width) ?? 0, height: (swapped ? metadata.width : metadata.height) ?? 0, exif: metadataEvidence(exif, googleMetadata) };
  } catch { throw new ApiError(422, 'UNSUPPORTED_ANALYSIS_IMAGE', 'This local image could not be decoded safely for analysis.'); }
}
export async function prepareAnalysisImage(file: string, maximumDimension = 1024): Promise<{ data: Uint8Array; mimeType: string }> {
  try {
    const data = await sharp(file, { limitInputPixels: 100_000_000, failOn: 'error' }).rotate().resize({ width: maximumDimension, height: maximumDimension, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 80 }).toBuffer();
    if (data.byteLength > 8 * 1024 * 1024) throw new Error('Preview too large');
    return { data, mimeType: 'image/jpeg' };
  } catch { throw new ApiError(422, 'UNSUPPORTED_ANALYSIS_IMAGE', 'This local image could not be prepared safely for analysis.'); }
}
