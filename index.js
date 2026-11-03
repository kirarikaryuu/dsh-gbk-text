/**
 * dsh-gbk-text — decode GBK/GB18030 text at the filesystem seam so every
 * reader sees text instead of FS_NOT_TEXT.
 *
 * Why this exists: dsh-fs-local decodes text with a strict
 * TextDecoder("utf-8", { fatal: true }) and raises FS_NOT_TEXT on any invalid
 * byte. The sidebar document preview surfaces that as
 * "该格式文件暂时无法预览", so a GBK file cannot be previewed at all — not as
 * plain text, not as Markdown, not as code.
 *
 * What this plugin does: it wraps the two text read methods of the composed
 * `fs` service (readText and streamText). The original implementation is
 * tried first, so UTF-8 files and every existing guarantee are untouched.
 * Only when the backend refuses with FS_NOT_TEXT does it read the bytes and
 * decode them as GB18030 (the superset of GBK/GB2312). The decoded text must
 * still look like text (no NUL, almost no control characters), so binary files
 * keep being refused exactly as before.
 *
 * Only GB18030 is enabled by default on purpose: GB18030 decodes almost any
 * byte pair, so trying Big5 or Shift-JIS automatically would turn their files
 * into plausible-looking mojibake instead of an honest refusal. Add them with
 * the row's `config.encodings` when the deployment actually needs them.
 *
 * Scope: host plane, one instance per process. Reads only — writes keep their
 * byte-exact behaviour from dsh-fs-encoding, and no model-facing tool is
 * shadowed here.
 *
 * @module dsh-gbk-text
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-gbk-text';

/** The composed filesystem service this plugin wraps. */
export const inject = ['fs'];

/** Marker so a second activation of this plugin never double-wraps. */
const PATCHED = Symbol.for('dsh-gbk-text.patched');

/** Whole-file decode cap for the fallback path; larger files keep the built-in refusal. */
const MAX_FALLBACK_BYTES = 8 * 1024 * 1024;

/** Yield size of a decoded fallback stream, in UTF-16 code units. */
const STREAM_CHUNK = 64 * 1024;

/** Default fallback encodings. GB18030 covers GBK and GB2312. */
const DEFAULT_ENCODINGS = ['gb18030'];

/**
 * Read the configured fallback list, keeping only encodings the runtime's
 * TextDecoder actually supports so a bad row cannot break every text read.
 *
 * @param config - the plugin row's config, when one was supplied.
 * @returns the encodings to try after UTF-8, in order.
 */
function resolveEncodings(config) {
  const requested = Array.isArray(config?.encodings) ? config.encodings : DEFAULT_ENCODINGS;
  const usable = [];
  for (const encoding of requested) {
    if (typeof encoding !== 'string' || encoding.length === 0) continue;
    try {
      new TextDecoder(encoding, { fatal: true });
      usable.push(encoding);
    } catch {
      // Unsupported encoding name: skip it rather than failing the whole plugin.
    }
  }
  return usable.length > 0 ? usable : DEFAULT_ENCODINGS;
}

/** Strict UTF-8 decoder: rejects rather than substituting U+FFFD. */
const UTF8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Whether a decoded string is plausibly text rather than a binary file that
 * happened to decode. Allows tab/newline/form-feed and the C1 range's common
 * whitespace; refuses NUL outright.
 *
 * @param text - decoded candidate.
 * @returns true when the string is safe to show as text.
 */
function looksLikeText(text) {
  if (text.includes('\u0000')) return false;
  let control = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 9 || code === 10 || code === 12 || code === 13) continue;
    if (code < 32 || (code >= 0x7f && code < 0xa0)) control += 1;
  }
  return control <= Math.max(2, Math.floor(text.length * 0.002));
}

/**
 * Decode a byte buffer as UTF-8, a BOM-marked UTF-16, or the first configured
 * legacy encoding that yields plausible text.
 *
 * @param bytes - the file's bytes.
 * @param encodings - fallback encodings, in order; defaults to GB18030.
 * @returns the text and the encoding that produced it, or undefined when the
 *   bytes are not text this plugin is willing to show.
 */
export function decodeText(bytes, encodings = DEFAULT_ENCODINGS) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    try { return { text: UTF8.decode(bytes), encoding: 'utf-8' }; } catch { return undefined; }
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    try { return { text: new TextDecoder('utf-16le').decode(bytes), encoding: 'utf-16le' }; } catch { return undefined; }
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    try { return { text: new TextDecoder('utf-16be').decode(bytes), encoding: 'utf-16be' }; } catch { return undefined; }
  }
  try {
    const text = UTF8.decode(bytes);
    if (looksLikeText(text)) return { text, encoding: 'utf-8' };
  } catch {
    // Not UTF-8: fall through to the configured legacy encodings.
  }
  for (const encoding of encodings) {
    let text;
    try {
      text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    } catch {
      continue;
    }
    if (looksLikeText(text)) return { text, encoding };
  }
  return undefined;
}

/** @param error - a thrown value. @returns whether it is the backend's non-text refusal. */
function isNotTextRefusal(error) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'FS_NOT_TEXT';
}

/**
 * Wrap the composed filesystem's text reads.
 *
 * @param ctx - owning plugin context, carrying the `fs` service.
 * @param config - optional row config; `config.encodings` replaces the fallback list.
 */
export function apply(ctx, config) {
  const fs = ctx.fs;
  if (!fs || typeof fs.readText !== 'function' || typeof fs.streamText !== 'function') return;
  if (fs[PATCHED]) return;

  const encodings = resolveEncodings(config);
  const readText = fs.readText.bind(fs);
  const streamText = fs.streamText.bind(fs);
  const readBytes = fs.readBytes.bind(fs);

  const readDecoded = async (target, signal) => {
    let bytes;
    try {
      bytes = await readBytes(target, signal, MAX_FALLBACK_BYTES);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'FS_TOO_LARGE') return undefined;
      throw error;
    }
    return decodeText(bytes, encodings);
  };

  const patched = {
    async readText(target, signal) {
      try {
        return await readText(target, signal);
      } catch (error) {
        if (!isNotTextRefusal(error)) throw error;
        const decoded = await readDecoded(target, signal);
        if (decoded === undefined) throw error;
        return decoded.text;
      }
    },
    async streamText(target, signal) {
      const decoded = await readDecoded(target, signal);
      if (decoded === undefined) return streamText(target, signal);
      const { text } = decoded;
      return (async function* chunks() {
        if (text.length === 0) { yield ''; return; }
        for (let index = 0; index < text.length; index += STREAM_CHUNK) yield text.slice(index, index + STREAM_CHUNK);
      })();
    },
  };

  const previous = { readText: fs.readText, streamText: fs.streamText };
  fs.readText = patched.readText;
  fs.streamText = patched.streamText;
  Object.defineProperty(fs, PATCHED, { value: true, enumerable: false, configurable: true });

  ctx.effect(() => () => {
    fs.readText = previous.readText;
    fs.streamText = previous.streamText;
    delete fs[PATCHED];
  });
}

export default { name, inject, apply };
