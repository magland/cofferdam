import { createHash } from 'crypto';
import { VENDOR_AGE_JS } from './vendor-age';

// The script for pages that touch age-encrypted files: the blob view of a
// `*.age` file, the editor for one, and the new-file form (which may be given
// a `*.age` name). Served as /assets/age.js and loaded only by those pages,
// so the 300 KB of vendored cryptography is never fetched by a page that
// cannot need it; ordinary pages carry /assets/page.js alone.
//
// Everything here runs on the reader's side of the trust line. The server
// hands out ciphertext and receives ciphertext; the passphrase lives in a
// closure for exactly as long as the page needs it, is never written to
// storage of any kind, and the plaintext exists only in the DOM of this open
// page. That is the entire point of the feature, so nothing below may relax
// it. See docs/encrypted-files.md for the contract as the user sees it.
//
// Like page.js, everything page-specific arrives through data attributes
// (data-age-view, data-age-edit, data-age-new and their companions), so this
// file is one cacheable body for every vault. Unlike page.js it may assume a
// modern browser: WebCrypto is required by the cryptography itself, so there
// is nobody older to degrade for. The vendored bundle (src/vendor-age.ts)
// provides window.MochiAge (typage) and window.MochiMarkdownIt.

const GLUE_JS = `
(function () {
  'use strict';

  var ARMOR_HEAD = '-----BEGIN AGE ENCRYPTED FILE-----';

  function fetchCiphertext(url) {
    return fetch(url).then(function (resp) {
      if (!resp.ok) throw new Error('Could not fetch the file (HTTP ' + resp.status + ').');
      return resp.arrayBuffer();
    }).then(function (buf) { return new Uint8Array(buf); });
  }

  // Both framings are read: the armor the browser editor writes, and the
  // binary framing an age CLI writes by default.
  function decodeFramed(bytes) {
    var head = '';
    for (var i = 0; i < Math.min(bytes.length, ARMOR_HEAD.length); i++) head += String.fromCharCode(bytes[i]);
    if (head === ARMOR_HEAD) return window.MochiAge.armor.decode(new TextDecoder().decode(bytes));
    return bytes;
  }

  function decryptText(bytes, pass) {
    var d = new window.MochiAge.Decrypter();
    d.addPassphrase(pass);
    return d.decrypt(decodeFramed(bytes), 'text');
  }

  // Armored output on purpose: it commits as text, so the vault's diffs,
  // blame, and text-shaped write path all keep working over the ciphertext.
  function encryptArmored(text, pass) {
    var e = new window.MochiAge.Encrypter();
    e.setPassphrase(pass);
    return e.encrypt(text).then(function (bytes) { return window.MochiAge.armor.encode(bytes) + '\\n'; });
  }

  // Passphrase failures all look alike from the outside, and honesty about
  // which it was is not available: age reports only that no recipient matched.
  function explain(err) {
    var msg = err && err.message ? String(err.message) : String(err);
    if (msg.indexOf('no identity matched') !== -1) {
      return 'That passphrase does not open this file. (A corrupted file reports the same way.)';
    }
    if (msg.indexOf('invalid header') !== -1 || msg.indexOf('parsing header') !== -1) {
      return 'This is not a readable age file: ' + msg;
    }
    return msg;
  }

  function setError(box, msg) {
    var el = box.querySelector('.age-error');
    if (!el) return;
    if (msg) { el.textContent = msg; el.hidden = false; } else { el.hidden = true; }
  }

  function setBusy(box, busy) {
    var btn = box.querySelector('.age-unlock button');
    if (btn) btn.disabled = busy;
  }

  // ---- the blob page ----

  // The decrypted file is rendered the way its inner name asks: markdown as a
  // document, anything else as preformatted text. Rendering happens here
  // rather than on the server for the same reason decryption does.
  function renderPlain(out, inner, text) {
    out.textContent = '';
    if (inner === 'markdown') {
      var md = window.MochiMarkdownIt({ html: false, linkify: true });
      var doc = document.createElement('div');
      doc.className = 'rendered markdown-body';
      doc.innerHTML = md.render(text);
      out.appendChild(doc);
    } else {
      var pre = document.createElement('pre');
      pre.className = 'age-plain';
      pre.textContent = text;
      out.appendChild(pre);
    }
    out.hidden = false;
  }

  function wireView(box) {
    var form = box.querySelector('form.age-unlock');
    var pass = box.querySelector('input[type=password]');
    var out = box.querySelector('.age-output');
    var lock = box.querySelector('[data-age-lock]');
    if (!form || !pass || !out) return;
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      setError(box, null);
      setBusy(box, true);
      fetchCiphertext(box.getAttribute('data-age-raw'))
        .then(function (bytes) { return decryptText(bytes, pass.value); })
        .then(function (text) {
          pass.value = '';
          renderPlain(out, box.getAttribute('data-age-inner'), text);
          form.hidden = true;
          if (lock) lock.hidden = false;
        })
        .catch(function (err) { setError(box, explain(err)); })
        .then(function () { setBusy(box, false); });
    });
    if (lock) lock.addEventListener('click', function () {
      out.textContent = '';
      out.hidden = true;
      lock.hidden = true;
      form.hidden = false;
      pass.focus();
    });
    pass.focus();
  }

  // ---- the editor ----

  // The server cannot fill the textarea, so the page starts locked: the same
  // unlock form as the blob view, and on success the plaintext lands in the
  // editor and the passphrase stays in this closure for the re-encryption at
  // commit time. The textarea carries no name; what the form posts is the
  // hidden content field, written at the last moment with fresh ciphertext.
  function wireEdit(form) {
    var passForm = document.querySelector('form.age-unlock[data-age-for-edit]');
    var passInput = passForm ? passForm.querySelector('input[type=password]') : null;
    var editor = form.querySelector('textarea.code-editor');
    var content = form.querySelector('input[name=content]');
    var commitBtn = form.querySelector('button[type=submit]');
    if (!passForm || !passInput || !editor || !content || !commitBtn) return;
    var passphrase = null;
    var readyToPost = false;
    passForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      setError(passForm, null);
      setBusy(passForm, true);
      var pass = passInput.value;
      fetchCiphertext(form.getAttribute('data-age-raw'))
        .then(function (bytes) { return decryptText(bytes, pass); })
        .then(function (text) {
          passphrase = pass;
          passInput.value = '';
          editor.value = text;
          editor.disabled = false;
          commitBtn.disabled = false;
          passForm.hidden = true;
          form.hidden = false;
          editor.focus();
        })
        .catch(function (err) { setError(passForm, explain(err)); })
        .then(function () { setBusy(passForm, false); });
    });
    form.addEventListener('submit', function (ev) {
      if (readyToPost) return;
      ev.preventDefault();
      if (passphrase === null) return;
      commitBtn.disabled = true;
      encryptArmored(editor.value, passphrase)
        .then(function (armored) {
          content.value = armored;
          readyToPost = true;
          form.submit();
        })
        .catch(function (err) {
          commitBtn.disabled = false;
          setError(form, explain(err));
        });
    });
    passInput.focus();
  }

  // ---- the new-file form ----

  // The form is the ordinary one; a file name ending in .age reveals the
  // passphrase pair and switches the commit to encrypt-then-post. The
  // passphrase inputs carry no name, so they can never be posted, and the
  // server refuses a .age path whose content is not age-shaped, so a page
  // where this script failed cannot commit plaintext under the name.
  function wireNew(form) {
    var filename = form.querySelector('input[name=filename]');
    var fields = form.querySelector('.age-pass-fields');
    var editor = form.querySelector('textarea[name=content]');
    if (!filename || !fields || !editor) return;
    var inputs = fields.querySelectorAll('input[type=password]');
    if (inputs.length !== 2) return;
    var readyToPost = false;
    function wantsAge() { return /\\.age$/i.test(filename.value.trim()); }
    function toggle() { fields.hidden = !wantsAge(); }
    filename.addEventListener('input', toggle);
    toggle();
    form.addEventListener('submit', function (ev) {
      if (readyToPost || !wantsAge()) return;
      ev.preventDefault();
      setError(fields, null);
      if (inputs[0].value === '') { setError(fields, 'Choose a passphrase for this file.'); return; }
      if (inputs[0].value !== inputs[1].value) { setError(fields, 'The passphrases do not match.'); return; }
      encryptArmored(editor.value, inputs[0].value)
        .then(function (armored) {
          inputs[0].value = '';
          inputs[1].value = '';
          editor.removeAttribute('name');
          var hidden = document.createElement('input');
          hidden.type = 'hidden';
          hidden.name = 'content';
          hidden.value = armored;
          form.appendChild(hidden);
          readyToPost = true;
          form.submit();
        })
        .catch(function (err) { setError(fields, explain(err)); });
    });
  }

  var view = document.querySelector('[data-age-view]');
  if (view) wireView(view);
  var edit = document.querySelector('form[data-age-edit]');
  if (edit) wireEdit(edit);
  var fresh = document.querySelector('form[data-age-new]');
  if (fresh) wireNew(fresh);
})();
`;

let made: { body: string; tag: string } | null = null;

/** The served asset: the vendored bundle and the glue above, one body, one tag. */
export function ageScript(): { body: string; tag: string } {
  if (made) return made;
  const body = VENDOR_AGE_JS + '\n' + GLUE_JS;
  made = { body, tag: createHash('sha256').update(body).digest('hex').slice(0, 12) };
  return made;
}
