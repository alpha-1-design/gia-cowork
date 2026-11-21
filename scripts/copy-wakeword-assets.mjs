#!/usr/bin/env node
/**
 * Stage the openWakeWord ONNX assets into `public/openwakeword/models`.
 *
 * The wake-word engine fetches its models over HTTP from a base asset URL, so
 * they have to exist as real files under the app's origin. Copying them out of
 * node_modules at dev/build time keeps ~5.5MB of binaries out of git while
 * still shipping them self-hosted -- which matters twice over: audio never
 * leaves the machine, and the engine does not depend on a third-party CDN
 * being reachable at runtime.
 *
 * Only the ONNX variants are staged; the .tflite duplicates are dead weight in
 * a browser.
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'node_modules', 'openwakeword-wasm-browser', 'models');
const outDir = join(root, 'public', 'openwakeword', 'models');

/** The pipeline needs the mel + embedding + VAD front-end plus one keyword head. */
const FILES = [
  'melspectrogram.onnx',
  'embedding_model.onnx',
  'silero_vad.onnx',
  'hey_jarvis_v0.1.onnx',
];

/** ORT runtime wasm — staged so the voice VAD (and wake word) never hit the
 *  jsDelivr CDN at runtime; the custom protocol can't set wasmPaths defaults. */
const ORT_DIR = join(root, 'node_modules', 'openwakeword-wasm-browser', 'node_modules', 'onnxruntime-web', 'dist');
const ORT_FILES = ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'];

function main() {
  if (!existsSync(srcDir)) {
    console.warn('[wakeword] openwakeword-wasm-browser is not installed; skipping asset staging.');
    return;
  }

  mkdirSync(outDir, { recursive: true });

  let copied = 0;
  let skipped = 0;
  for (const name of FILES) {
    const src = join(srcDir, name);
    const dest = join(outDir, name);
    if (!existsSync(src)) {
      console.warn(`[wakeword] missing model file: ${name}`);
      skipped++;
      continue;
    }
    // Skip when the staged copy is already byte-for-byte current, so repeat
    // builds stay fast.
    if (existsSync(dest) && statSync(dest).size === statSync(src).size) {
      skipped++;
      continue;
    }
    copyFileSync(src, dest);
    copied++;
  }

  console.log(`[wakeword] staged openWakeWord assets -> public/openwakeword/models (${copied} copied, ${skipped} up to date)`);

  // ORT runtime → public/openwakeword/ort/ (voice vad sets wasmPaths here).
  const ortOut = join(root, 'public', 'openwakeword', 'ort');
  if (existsSync(ORT_DIR)) {
    mkdirSync(ortOut, { recursive: true });
    for (const name of ORT_FILES) {
      const src = join(ORT_DIR, name);
      if (existsSync(src)) copyFileSync(src, join(ortOut, name));
      else console.warn(`[wakeword] missing ORT file: ${name}`);
    }
    console.log('[wakeword] staged onnxruntime-web wasm -> public/openwakeword/ort');
  } else {
    console.warn('[wakeword] onnxruntime-web dist not found; voice VAD will fall back to CDN.');
  }
}

main();