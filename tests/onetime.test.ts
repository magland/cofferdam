import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createOneTimeStore, mintHandoffCode, normalizeHandoffCode } from '../src/onetime';

describe('one-time store', () => {
  it('redeems a value exactly once', () => {
    const store = createOneTimeStore<string>();
    const id = store.put('hello', 60000);
    assert.equal(store.take(id), 'hello');
    assert.equal(store.take(id), null);
  });

  it('peeks without consuming', () => {
    const store = createOneTimeStore<string>();
    const id = store.put('hello', 60000);
    assert.equal(store.peek(id), 'hello');
    assert.equal(store.peek(id), 'hello');
    assert.equal(store.take(id), 'hello');
    assert.equal(store.peek(id), null);
  });

  it('expires', async () => {
    const store = createOneTimeStore<string>();
    const id = store.put('hello', 5);
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(store.take(id), null);
  });

  it('never redeems an id it did not mint', () => {
    const store = createOneTimeStore<string>();
    store.put('hello', 60000);
    assert.equal(store.take('made-up'), null);
  });
});

describe('handoff codes', () => {
  it('mints in the display shape from the unambiguous alphabet', () => {
    for (let i = 0; i < 20; i++) {
      assert.match(mintHandoffCode(), /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
    }
  });

  it('normalizes case, spaces, and the dash back to the minted form', () => {
    assert.equal(normalizeHandoffCode(' mq4v 7xkp '), 'MQ4V-7XKP');
    assert.equal(normalizeHandoffCode('MQ4V-7XKP'), 'MQ4V-7XKP');
    assert.equal(normalizeHandoffCode('nope!'), 'NOPE');
  });
});
