import * as ImageManipulator from 'expo-image-manipulator';
import { analyzeMapPhoto, type VisionResponse } from '@msp/engine';
import type { Settings } from '../state/store';

/** Claude vision works best at ≤ 1568 px on the long edge; larger costs more and isn't sharper. */
const MAX_EDGE = 1568;

export async function analyzePhoto(uri: string, width: number, height: number, settings: Settings, hint?: string): Promise<VisionResponse> {
  if (settings.visionMode === 'mock') {
    return analyzeMapPhoto({ imageBase64: '', mediaType: 'image/jpeg', hint }, { mode: 'mock' });
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  const out = await ImageManipulator.manipulateAsync(uri, scale < 1 ? [{ resize: { width: Math.round(width * scale), height: Math.round(height * scale) } }] : [], {
    compress: 0.85,
    format: ImageManipulator.SaveFormat.JPEG,
    base64: true,
  });
  if (!out.base64) throw new Error('Could not read the photo.');
  return analyzeMapPhoto(
    { imageBase64: out.base64, mediaType: 'image/jpeg', hint },
    { mode: 'proxy', proxyUrl: settings.proxyUrl, appToken: settings.appToken || undefined },
  );
}
