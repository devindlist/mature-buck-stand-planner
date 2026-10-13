import * as ImageManipulator from 'expo-image-manipulator';
import { analyzeMapPhoto, fitVisionImage, MAX_VISION_BASE64_CHARS, type VisionResponse } from '@msp/engine';
import type { Settings } from '../state/store';

/**
 * Photos are downscaled to Claude's high-resolution vision limit (2576 px long edge, about
 * 3.75 MP; see MAX_VISION_EDGE_PX in the engine) rather than the old 1568 px, so thin trails,
 * fence lines and contour detail survive. Smaller photos are never upscaled.
 */
const JPEG_QUALITY = 0.85;
/** Used once if the first encode is over the proxy's size limit (very detailed aerial imagery). */
const JPEG_QUALITY_FALLBACK = 0.6;

export async function analyzePhoto(uri: string, width: number, height: number, settings: Settings, hint?: string): Promise<VisionResponse> {
  if (settings.visionMode === 'mock') {
    return analyzeMapPhoto({ imageBase64: '', mediaType: 'image/jpeg', hint }, { mode: 'mock' });
  }
  const fit = fitVisionImage(width, height);
  const actions = fit.resized ? [{ resize: { width: fit.width, height: fit.height } }] : [];
  const encode = (compress: number) =>
    ImageManipulator.manipulateAsync(uri, actions, { compress, format: ImageManipulator.SaveFormat.JPEG, base64: true });

  let out = await encode(JPEG_QUALITY);
  if (out.base64 && out.base64.length > MAX_VISION_BASE64_CHARS) out = await encode(JPEG_QUALITY_FALLBACK);
  if (!out.base64) throw new Error('Could not read the photo.');
  if (out.base64.length > MAX_VISION_BASE64_CHARS) throw new Error('This photo is too detailed to send. Crop it or take a screenshot of a smaller area.');
  return analyzeMapPhoto(
    { imageBase64: out.base64, mediaType: 'image/jpeg', hint },
    { mode: 'proxy', proxyUrl: settings.proxyUrl, appToken: settings.appToken || undefined },
  );
}
