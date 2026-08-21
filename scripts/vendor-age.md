# Regenerating src/vendor-age.ts

`src/vendor-age.ts` carries the third-party client code for the encrypted-file
pages as one string, so that `tsc` alone still builds the whole server. It is
generated, not written; to update the libraries inside it, rebuild it like
this and commit the result together with a matching version note in the file
header and in this file.

```bash
mkdir /tmp/vendor-age && cd /tmp/vendor-age
npm init -y
npm install age-encryption@0.3.0 markdown-it@14 esbuild
cat > entry.js <<'EOF'
import { Encrypter, Decrypter, armor } from 'age-encryption';
import markdownit from 'markdown-it';
window.MochiAge = { Encrypter, Decrypter, armor };
window.MochiMarkdownIt = markdownit;
EOF
npx esbuild entry.js --bundle --minify --format=iife --target=es2018 --outfile=vendor.js
node -e '
const fs = require("fs");
const body = fs.readFileSync("vendor.js", "utf8");
fs.writeFileSync("vendor-age.ts", "// Generated file -- do not edit by hand.\n//\n// Third-party client code for the encrypted-file pages, bundled into one\n// string so tsc alone still builds the whole server (the project has no\n// bundler in its build). Regenerate with scripts/vendor-age.md when updating.\n//\n// Contents, bundled minified as an IIFE (esbuild, --target=es2018):\n//   age-encryption 0.3.0 (typage, github.com/FiloSottile/typage)  -> window.MochiAge\n//   markdown-it 14.3.0                                            -> window.MochiMarkdownIt\n//\n// Licenses: typage BSD-3-Clause; markdown-it MIT.\n\nexport const VENDOR_AGE_JS: string = " + JSON.stringify(body) + ";\n");
'
cp vendor-age.ts <repo>/src/vendor-age.ts
```

Update the version pins in the `npm install` line and in the header text
together; the header is what a reader trusts about what is inside the string.
After regenerating, run the unit tests: tests/agescript.test.ts round-trips a
real encryption through the bundle, so a broken vendor build fails there
rather than in someone's browser.
