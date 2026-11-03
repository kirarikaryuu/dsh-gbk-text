import { decodeText, apply } from '../index.js';

/**
 * Self-contained verification: no dependencies, no fixtures on disk, so CI can
 * run it with a plain `node test/verify.mjs`.
 */

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log('PASS', name, detail);
  } else {
    fail += 1;
    console.log('FAIL', name, detail);
  }
}

const GBK_TEXT = '第一行：这是一个 GBK 编码的文本文件。\n第二行：中文预览测试，包含标点，、。！？\n第三行：English mixed 123.\n';
const GBK_BYTES = [181, 218, 210, 187, 208, 208, 163, 186, 213, 226, 202, 199, 210, 187, 184, 246, 32, 71, 66, 75, 32, 177, 224, 194, 235, 181, 196, 206, 196, 177, 190, 206, 196, 188, 254, 161, 163, 10, 181, 218, 182, 254, 208, 208, 163, 186, 214, 208, 206, 196, 212, 164, 192, 192, 178, 226, 202, 212, 163, 172, 176, 252, 186, 172, 177, 234, 181, 227, 163, 172, 161, 162, 161, 163, 163, 161, 163, 191, 10, 181, 218, 200, 253, 208, 208, 163, 186, 69, 110, 103, 108, 105, 115, 104, 32, 109, 105, 120, 101, 100, 32, 49, 50, 51, 46, 10];
const BIG5_TEXT = '你好，世界！這是 Big5 編碼測試。';
const BIG5_BYTES = [167, 65, 166, 110, 161, 65, 165, 64, 172, 201, 161, 73, 179, 111, 172, 79, 32, 66, 105, 103, 53, 32, 189, 115, 189, 88, 180, 250, 184, 213, 161, 67];
const SJIS_TEXT = 'こんにちは世界。これは Shift_JIS のテストです。';
const SJIS_BYTES = [130, 177, 130, 241, 130, 201, 130, 191, 130, 205, 144, 162, 138, 69, 129, 66, 130, 177, 130, 234, 130, 205, 32, 83, 104, 105, 102, 116, 95, 74, 73, 83, 32, 130, 204, 131, 101, 131, 88, 131, 103, 130, 197, 130, 183, 129, 66];
const UTF8_TEXT = '你好，世界！UTF-8 无 BOM。\n第二行。';

const bytes = (list) => Uint8Array.from(list);
const withBom = (bom, list) => Uint8Array.from([...bom, ...list]);

// --- decodeText: the encodings that must pass through unchanged ------------
const utf8 = decodeText(new TextEncoder().encode(UTF8_TEXT));
check('utf-8 passes through', utf8?.encoding === 'utf-8' && utf8.text === UTF8_TEXT);

const utf8Bom = decodeText(withBom([0xef, 0xbb, 0xbf], [...new TextEncoder().encode(UTF8_TEXT)]));
check('utf-8 BOM strips the mark', utf8Bom?.encoding === 'utf-8' && utf8Bom.text === UTF8_TEXT);

// '你好' in UTF-16LE: U+4F60 U+597D
const utf16 = decodeText(withBom([0xff, 0xfe], [0x60, 0x4f, 0x7d, 0x59]));
check('utf-16le BOM decodes', utf16?.encoding === 'utf-16le' && utf16.text === '你好');

// --- decodeText: the case this plugin exists for ---------------------------
const gbk = decodeText(bytes(GBK_BYTES));
check('gbk decodes as gb18030', gbk?.encoding === 'gb18030' && gbk.text === GBK_TEXT, gbk?.encoding);

// --- documented trade-off: other legacy encodings fall back to gb18030 ----
const big5 = decodeText(bytes(BIG5_BYTES));
check('big5 bytes fall back to gb18030 (documented)', big5?.encoding === 'gb18030');
const sjis = decodeText(bytes(SJIS_BYTES));
check('shift_jis bytes fall back to gb18030 (documented)', sjis?.encoding === 'gb18030');

// --- opt-in encodings ------------------------------------------------------
const big5OptIn = decodeText(bytes(BIG5_BYTES), ['big5']);
check('opt-in big5 decodes', big5OptIn?.encoding === 'big5' && big5OptIn.text === BIG5_TEXT);
const sjisOptIn = decodeText(bytes(SJIS_BYTES), ['shift_jis']);
check('opt-in shift_jis decodes', sjisOptIn?.encoding === 'shift_jis' && sjisOptIn.text === SJIS_TEXT);

// --- refusals --------------------------------------------------------------
const binary = Uint8Array.from({ length: 256 }, (_, i) => (i % 2 === 0 ? 0 : i));
check('binary is refused', decodeText(binary) === undefined);
check('NUL is refused', decodeText(Uint8Array.from([0x41, 0x00, 0x42, 0x00])) === undefined);
check('empty file is text', decodeText(new Uint8Array(0))?.text === '');

// --- the fs wrapper --------------------------------------------------------
class FakeFs {
  constructor(data) { this.data = data; }
  async readText() {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(this.data);
    } catch {
      throw Object.assign(new Error('invalid UTF-8 text'), { code: 'FS_NOT_TEXT' });
    }
  }
  async streamText() {
    const text = await this.readText();
    return (async function* () { yield text; })();
  }
  async readBytes() { return this.data; }
}

const disposers = [];
function mount(data, config) {
  const fs = new FakeFs(data);
  apply({ fs, effect: (fn) => disposers.push(fn) }, config);
  return fs;
}

const gbkFs = mount(bytes(GBK_BYTES));
check('wrapper readText decodes gbk', (await gbkFs.readText({})) === GBK_TEXT);
let streamed = '';
for await (const chunk of await gbkFs.streamText({})) streamed += chunk;
check('wrapper streamText decodes gbk', streamed === GBK_TEXT);

const utf8Fs = mount(new TextEncoder().encode(UTF8_TEXT));
check('wrapper leaves utf-8 untouched', (await utf8Fs.readText({})) === UTF8_TEXT);

const binaryFs = mount(binary);
let refused = false;
try { await binaryFs.readText({}); } catch (error) { refused = error.code === 'FS_NOT_TEXT'; }
check('wrapper still refuses binary', refused);

const big5Fs = mount(bytes(BIG5_BYTES), { encodings: ['big5'] });
check('wrapper honours config.encodings', (await big5Fs.readText({})) === BIG5_TEXT);

const excludedFs = mount(bytes(GBK_BYTES), { excludeEncodings: ['gb18030'] });
let excludedRefused = false;
try { await excludedFs.readText({}); } catch (error) { excludedRefused = error.code === 'FS_NOT_TEXT'; }
check('excludeEncodings can turn the fallback off', excludedRefused);

const overrideFs = mount(bytes(BIG5_BYTES), { encodings: ['big5'], excludeEncodings: ['big5'] });
check('excludeEncodings is ignored when encodings is set', (await overrideFs.readText({})) === BIG5_TEXT);

for (const fn of disposers) {
  const dispose = fn();
  if (typeof dispose === 'function') dispose();
}
check('dispose restores the originals', binaryFs.readText === FakeFs.prototype.readText);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
