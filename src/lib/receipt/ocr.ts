import type { ExtractedReceipt } from './extract'
import { extractReceiptFields } from './extract'

/**
 * Run OCR in the browser.
 *
 * 🔴 Loaded on demand, never in the app bundle. Tesseract pulls a WASM core and a language
 * model — several megabytes — and an employee filing an expense on mobile data should pay
 * that cost only when they actually photograph a receipt, and never when they type the
 * amount themselves. This is also why it is a separate module from `extract.ts`: the
 * parsing rules are small, pure and unit-tested; the engine is big and swappable.
 */
export async function readReceipt(
  image: Blob,
  onProgress?: (pct: number) => void,
): Promise<{ text: string; fields: ExtractedReceipt }> {
  const { createWorker } = await import('tesseract.js')

  const worker = await createWorker('eng', 1, {
    logger: (m: { status: string; progress: number }) => {
      if (m.status === 'recognizing text') onProgress?.(Math.round(m.progress * 100))
    },
  })

  try {
    const { data } = await worker.recognize(image)
    return { text: data.text, fields: extractReceiptFields(data.text) }
  } finally {
    await worker.terminate()
  }
}
