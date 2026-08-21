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

  // A working button says so. The scrypt derivation takes long enough to feel,
  // so while it runs the button shows the busy label the server put on it
  // ('Decrypting...', 'Encrypting...') rather than reading as a dead click.
  function setBtnBusy(btn, busy) {
    if (!btn) return;
    btn.disabled = busy;
    var label = btn.getAttribute('data-busy-label');
    if (!label) return;
    if (busy) {
      if (!btn.getAttribute('data-idle-label')) btn.setAttribute('data-idle-label', btn.textContent);
      btn.textContent = label;
    } else if (btn.getAttribute('data-idle-label')) {
      btn.textContent = btn.getAttribute('data-idle-label');
    }
  }

  function setBusy(box, busy) {
    setBtnBusy(box.querySelector('.age-unlock button[type=submit]'), busy);
  }

  // A failed passphrase leaves the input focused and selected, so the retry
  // is a retype rather than a clear-then-retype.
  function failedPass(input) { input.focus(); input.select(); }

  // Every passphrase input arrives wrapped with a show/hide toggle (the
  // .age-eye button the server renders beside it). Only the input's type
  // flips; the value still never carries a name, so it still cannot post.
  function wireEyes() {
    var wraps = document.querySelectorAll('.age-pass-wrap');
    for (var i = 0; i < wraps.length; i++) (function (wrap) {
      var input = wrap.querySelector('input');
      var btn = wrap.querySelector('.age-eye');
      if (!input || !btn) return;
      btn.addEventListener('click', function () {
        var show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        wrap.classList.toggle('showing', show);
        btn.setAttribute('aria-pressed', show ? 'true' : 'false');
        btn.setAttribute('aria-label', show ? 'Hide the passphrase' : 'Show the passphrase');
        input.focus();
      });
    })(wraps[i]);
  }

  // The plaintext to copy comes from the closure, not from the DOM, so it is
  // exact bytes even where the output was rendered as a markdown document.
  function copyPlain(btn, text) {
    if (!navigator.clipboard || !navigator.clipboard.writeText) return;
    navigator.clipboard.writeText(text).then(function () {
      btn.classList.add('copied');
      setTimeout(function () { btn.classList.remove('copied'); }, 1400);
    }, function () {});
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

  // On unlock the explanatory card gives way to a slim bar over the output:
  // a note that the decryption stayed in the page, a copy of the exact
  // plaintext, and the lock that puts the card back. Locking drops the
  // plaintext from the closure as well as from the DOM.
  function wireView(box) {
    var form = box.querySelector('form.age-unlock');
    var pass = form ? form.querySelector('input') : null;
    var out = box.querySelector('.age-output');
    var card = box.querySelector('.age-card');
    var bar = box.querySelector('[data-age-bar]');
    var lock = box.querySelector('[data-age-lock]');
    var copy = box.querySelector('[data-age-copy]');
    if (!form || !pass || !out || !card) return;
    var plain = null;
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      setError(card, null);
      setBusy(card, true);
      fetchCiphertext(box.getAttribute('data-age-raw'))
        .then(function (bytes) { return decryptText(bytes, pass.value); })
        .then(function (text) {
          plain = text;
          pass.value = '';
          renderPlain(out, box.getAttribute('data-age-inner'), text);
          card.hidden = true;
          if (bar) bar.hidden = false;
        })
        .catch(function (err) { setError(card, explain(err)); failedPass(pass); })
        .then(function () { setBusy(card, false); });
    });
    if (lock) lock.addEventListener('click', function () {
      plain = null;
      out.textContent = '';
      out.hidden = true;
      if (bar) bar.hidden = true;
      card.hidden = false;
      pass.focus();
    });
    if (copy) copy.addEventListener('click', function () {
      if (plain !== null) copyPlain(copy, plain);
    });
    pass.focus();
  }

  // ---- the editor ----

  // The server cannot fill the textarea, so the page starts locked: the same
  // unlock form as the blob view, and on success the plaintext lands in the
  // editor and the passphrase stays in this closure for the re-encryption at
  // commit time. The textarea carries no name; what the form posts is the
  // hidden content field, written at the last moment with fresh ciphertext.
  // An optional pair of new-passphrase inputs (also nameless) re-keys the
  // file: filled and matching, the commit encrypts with the new passphrase.
  function wireEdit(form) {
    var passForm = document.querySelector('form.age-unlock[data-age-for-edit]');
    var passInput = passForm ? passForm.querySelector('input') : null;
    var card = passForm ? passForm.closest('.age-card') : null;
    var editor = form.querySelector('textarea.code-editor');
    var content = form.querySelector('input[name=content]');
    var commitBtn = form.querySelector('button[type=submit]');
    var path = form.querySelector('input[name=path]');
    var renameWarn = form.querySelector('[data-age-rename-warn]');
    var newPass = form.querySelectorAll('.age-newpass input');
    if (!passForm || !passInput || !card || !editor || !content || !commitBtn) return;
    var passphrase = null;
    var readyToPost = false;
    passForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      setError(card, null);
      setBusy(card, true);
      var pass = passInput.value;
      fetchCiphertext(form.getAttribute('data-age-raw'))
        .then(function (bytes) { return decryptText(bytes, pass); })
        .then(function (text) {
          passphrase = pass;
          passInput.value = '';
          editor.value = text;
          editor.disabled = false;
          commitBtn.disabled = false;
          card.hidden = true;
          form.hidden = false;
          editor.focus();
        })
        .catch(function (err) { setError(card, explain(err)); failedPass(passInput); })
        .then(function () { setBusy(card, false); });
    });
    // Renaming away from .age is legal but almost never meant: the commit
    // would still be ciphertext, under a name the vault reads as plain text.
    // The warning appears as the name changes, not as a surprise afterwards.
    if (path && renameWarn) path.addEventListener('input', function () {
      renameWarn.hidden = /\\.age$/i.test(path.value.trim());
    });
    form.addEventListener('submit', function (ev) {
      if (readyToPost) return;
      ev.preventDefault();
      if (passphrase === null) return;
      var usePass = passphrase;
      if (newPass.length === 2 && (newPass[0].value !== '' || newPass[1].value !== '')) {
        if (newPass[0].value !== newPass[1].value) {
          setError(form, 'The new passphrases do not match.');
          failedPass(newPass[1]);
          return;
        }
        usePass = newPass[0].value;
      }
      setError(form, null);
      setBtnBusy(commitBtn, true);
      encryptArmored(editor.value, usePass)
        .then(function (armored) {
          content.value = armored;
          readyToPost = true;
          form.submit();
        })
        .catch(function (err) {
          setBtnBusy(commitBtn, false);
          setError(form, explain(err));
        });
    });
    passInput.focus();
  }

  // ---- the new-file form ----

  // The form is the ordinary one; a file name ending in .age reveals the
  // passphrase pair (and retires the hint that said so) and switches the
  // commit to encrypt-then-post. The passphrase inputs carry no name, so
  // they can never be posted, and the server refuses a .age path whose
  // content is not age-shaped, so a page where this script failed cannot
  // commit plaintext under the name.
  function wireNew(form) {
    var filename = form.querySelector('input[name=filename]');
    var fields = form.querySelector('.age-pass-fields');
    var hint = form.querySelector('[data-age-hint]');
    var editor = form.querySelector('textarea[name=content]');
    var commitBtn = form.querySelector('button[type=submit]');
    if (!filename || !fields || !editor) return;
    var inputs = fields.querySelectorAll('.age-pass-wrap input');
    if (inputs.length !== 2) return;
    var readyToPost = false;
    function wantsAge() { return /\\.age$/i.test(filename.value.trim()); }
    function toggle() {
      fields.hidden = !wantsAge();
      if (hint) hint.hidden = wantsAge();
    }
    filename.addEventListener('input', toggle);
    toggle();
    form.addEventListener('submit', function (ev) {
      if (readyToPost || !wantsAge()) return;
      ev.preventDefault();
      setError(fields, null);
      if (inputs[0].value === '') { setError(fields, 'Choose a passphrase for this file.'); failedPass(inputs[0]); return; }
      if (inputs[0].value !== inputs[1].value) { setError(fields, 'The passphrases do not match.'); failedPass(inputs[1]); return; }
      setBtnBusy(commitBtn, true);
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
        .catch(function (err) { setBtnBusy(commitBtn, false); setError(fields, explain(err)); });
    });
  }

  wireEyes();
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
