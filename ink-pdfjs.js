/* INK — pdf.js loader shared by import (covers/metadata) and the PDF engine */

let libP = null;
export function loadPdfjs() {
  if (!libP) {
    libP = import('./vendor-pdf.min.mjs').then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = new URL('./vendor-pdf.worker.min.mjs', import.meta.url).href;
      return lib;
    });
    libP.catch(() => { libP = null; });
  }
  return libP;
}

/**
 * Opens a PDF from a Blob. Large files are fed to pdf.js in ranges so the whole
 * file never has to be copied into memory; if that route fails we fall back to
 * reading it in one go.
 * Throws {name:'PasswordException', code:1|2} when a password is needed.
 */
export async function openPdf(blob, { password, onProgress } = {}) {
  const pdfjs = await loadPdfjs();
  const common = { password, isEvalSupported: false, useSystemFonts: true };
  const attempt = async (src) => {
    const task = pdfjs.getDocument({ ...common, ...src });
    if (onProgress) task.onProgress = (p) => onProgress(p.total ? p.loaded / p.total : 0);
    return task.promise;
  };
  const big = blob.size > 24 * 1024 * 1024;
  if (big && pdfjs.PDFDataRangeTransport) {
    try {
      class BlobTransport extends pdfjs.PDFDataRangeTransport {
        constructor(b) { super(b.size, null); this.b = b; }
        requestDataRange(begin, end) {
          this.b.slice(begin, end).arrayBuffer().then((buf) => this.onDataRange(begin, new Uint8Array(buf)));
        }
      }
      return await attempt({ range: new BlobTransport(blob), length: blob.size, disableAutoFetch: true, disableStream: true });
    } catch (e) {
      if (e?.name === 'PasswordException') throw e;
      /* fall through to plain data */
    }
  }
  return attempt({ data: new Uint8Array(await blob.arrayBuffer()) });
}

export const isPasswordError = (e) => e?.name === 'PasswordException';
