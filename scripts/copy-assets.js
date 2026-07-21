/**
 * Copies src/assets into dist/assets after a build.
 *
 * `tsc` emits .js and nothing else, so the PDF fonts under src/assets/fonts
 * never reached dist on their own — the compiled build would fall back to
 * Helvetica and lose the rupee sign, while `npm run dev` (which runs from src)
 * looked perfectly fine. Both now resolve assets at `<dir-of-code>/../assets`.
 */
const fs = require('fs');
const path = require('path');

const from = path.join(__dirname, '..', 'src', 'assets');
const to = path.join(__dirname, '..', 'dist', 'assets');

if (!fs.existsSync(from)) {
  console.log('copy-assets: no src/assets, nothing to do');
  process.exit(0);
}

fs.cpSync(from, to, { recursive: true });
console.log(`copy-assets: ${path.relative(process.cwd(), from)} -> ${path.relative(process.cwd(), to)}`);
