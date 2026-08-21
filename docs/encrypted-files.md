# Encrypted files

A private repository keeps its contents from other users, but not from the vault itself: a site admin can read it, a site-admin token taken from a backup machine can read it, and every backup of the vault carries a copy. For most files that is the right trade. For a file of credentials, an API token, or anything else whose exposure is expensive to undo, it is not, and the usual advice is simply never to commit such a thing. Here we take a second position: a file may be committed encrypted, in a format the vault stores and serves but cannot read, and the web interface will decrypt and edit it in the browser, so that the convenience of "a file in my repository" survives the encryption.

The format is [age](https://age-encryption.org), passphrase-encrypted, and the extension is the whole contract: a file named `*.age` is treated as an age ciphertext, the way a file named `*.md` is treated as markdown. Nothing about this is specific to Mochi Forge. The same file decrypts with the standard `age` CLI on any machine, an agent or a script can read it wherever the repository is cloned, and if the vault feature disappeared tomorrow the data would still be in a mainstream, audited format. The vault contributes storage, transport, and a viewer; the cryptography is the age specification's, and in the browser it runs in [typage](https://github.com/FiloSottile/typage), the age author's TypeScript implementation, vendored into the vault and served beside its other assets.

## What the interface does

Opening a `*.age` file shows a card instead of the file: the file's size, a passphrase field, and a Decrypt button. The ciphertext is fetched from the same raw endpoint the Raw button uses, the passphrase is fed to the decryption in the page, and the plaintext replaces the card, rendered by its inner name: `secrets.md.age` renders as markdown, anything else as plain text. A slim bar stands over the output with a Copy button for the exact plaintext and a Lock button that puts the card back and drops the plaintext from the page. In file listings a `*.age` file carries a lock icon, so what is encrypted is visible without opening anything. The passphrase and the plaintext exist only in the open page; neither is sent anywhere, cached anywhere, or stored anywhere, and navigating away discards both.

Editing works the same way in the other direction. The editor for a `*.age` file opens locked, since the server cannot fill it; entering the passphrase decrypts into the editor, and committing encrypts what is there and posts the fresh ciphertext through the same commit path, guards and all, that any other web edit takes. The passphrase used to open the file is the one used to seal it, unless the editor's optional new-passphrase fields are filled in, which re-keys the file in the same commit. Creating an encrypted file needs no separate form: give a new file a name ending in `.age` and the new-file page reveals a passphrase pair and encrypts before committing. A forgotten passphrase is not recoverable, by the vault or by anyone; that is the property being paid for.

The browser always writes the ASCII-armored spelling of the format, so the committed file is text: it diffs, it blames, and it travels through the text-shaped write paths. Both spellings are read, so a binary ciphertext made with `age -p` on the command line gets the same card and the same editor.

## What it protects against, and what it does not

The point of the arrangement is that the ciphertext and the key never meet outside your browser. A site admin reading the repository sees ciphertext. The vault's backups carry ciphertext. A stolen session cookie, or a token with the read role, reaches ciphertext. In each case the passphrase is a second, independent lock, and the vault holds no half of it.

Two honest limits. First, the vault serves the page and the script that do the decrypting, so a vault compromised deeply enough to serve altered pages could serve one that leaks a passphrase; in that scenario the operator of the vault is the attacker, which for a self-hosted vault usually means the person being attacked. The `age` CLI against a clone does not share this exposure, and remains the right tool where it matters. Second, the passphrase is the entire strength of the encryption, and a short one can be brute-forced offline by anyone who ever obtains the ciphertext. Use a long one.

Two operational notes in the same spirit. The web forms refuse to write plaintext under a `*.age` name, so a browser where the script failed cannot quietly commit the secret it was meant to encrypt; git and the API will write any bytes to any name, as they always have. And a secret that was ever committed unencrypted should be treated as exposed and rotated, not rewritten out of history: the vault's backups and clones remember what the branch no longer shows.

## In practice

```bash
# Create an encrypted file from the command line; the web editor can open it.
age -p -a -o secrets.md.age secrets.md

# Read one from a clone, wherever the repository is.
age -d secrets.md.age
```

In the browser, the file behaves as described above wherever it appears in a repository, public or private. Pairing the encryption with a private repository is the usual arrangement, since the two protections are independent and stack; on a public repository the ciphertext is public, and the passphrase carries the whole weight.
