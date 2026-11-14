import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createGame } from '../src/server/game.js';
import { createApp } from '../src/server/app.js';
import { normalizeServerConfig } from '../src/server/config.js';
import { STRINGS, LOCALES, DEFAULT_LOCALE, stringsFor } from '../src/shared/strings.js';

const quiet = () => {};
const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('string tables', () => {
  // Every leaf of one table, as [path, value].
  function leaves(obj, path = '') {
    return Object.entries(obj).flatMap(([k, v]) => (v && typeof v === 'object' ? leaves(v, `${path}${k}.`) : [[`${path}${k}`, v]]));
  }

  test('every language has the same keys, list lengths and placeholders as Italian', () => {
    const it = new Map(leaves(stringsFor('it')));
    for (const locale of LOCALES) {
      const other = new Map(leaves(stringsFor(locale)));
      assert.deepEqual([...other.keys()].sort(), [...it.keys()].sort(), locale);
      for (const [path, value] of it) {
        assert.equal(typeof other.get(path), typeof value, `${locale} ${path}`);
        assert.deepEqual(placeholders(other.get(path)), placeholders(value), `${locale} ${path}`);
        if (typeof value === 'string') assert.ok(other.get(path).length > 0, `${locale} ${path}`);
      }
    }
  });

  test('English is really English, and a few strings stay the same everywhere', () => {
    const it = stringsFor('it');
    const en = stringsFor('en');
    assert.notEqual(en.play.namePrompt, it.play.namePrompt);
    assert.notEqual(en.admin.title, it.admin.title);
    // "Bot N" names are recognised by pattern (reserved names, records): one spelling.
    assert.equal(en.botName, it.botName);
    // The /admin menu names each language in itself, whatever the page is in.
    assert.deepEqual(en.localeNames, it.localeNames);
    assert.deepEqual(Object.keys(it.localeNames), [...LOCALES]);
  });

  test('stringsFor falls back to Italian; STRINGS starts in Italian', () => {
    assert.equal(DEFAULT_LOCALE, 'it');
    assert.equal(stringsFor('fr'), stringsFor('it'));
    assert.equal(stringsFor('__proto__'), stringsFor('it'));
    assert.equal(STRINGS, stringsFor('it'));
  });
});

describe('language setting', () => {
  function fakeClient(game, opts) {
    const sent = [];
    const conn = game.connect({ send: (m) => sent.push(m), close: () => {} }, opts);
    return { send: (obj) => conn.message(JSON.stringify(obj)), last: (t) => sent.filter((m) => m.t === t).at(-1) };
  }
  function newGame() {
    const game = createGame({ log: quiet });
    const admin = fakeClient(game, { admin: true, isAuthorized: () => true });
    return { game, admin };
  }

  test('Italian by default; only a known language is accepted', () => {
    const { game, admin } = newGame();
    assert.equal(game.settings.locale, 'it');
    for (const bad of ['fr', 'EN', '', null, 1, ['en']]) {
      admin.send({ t: 'settings', locale: bad });
      assert.equal(admin.last('error').code, 'badMessage', JSON.stringify(bad));
    }
    assert.equal(game.settings.locale, 'it');
    admin.send({ t: 'settings', locale: 'en' });
    assert.equal(game.settings.locale, 'en');
  });

  test('every page hears about a switch: /display, phones and /admin', () => {
    const { game, admin } = newGame();
    const display = fakeClient(game);
    display.send({ t: 'hello', role: 'display' });
    const phone = fakeClient(game);
    phone.send({ t: 'hello', role: 'player' });
    phone.send({ t: 'join', name: 'Ada' });
    game.tickOnce();
    assert.equal(display.last('state').locale, 'it');
    assert.equal(phone.last('me').locale, 'it');
    admin.send({ t: 'settings', locale: 'en' });
    assert.equal(display.last('state').locale, 'en');
    assert.equal(phone.last('me').locale, 'en');
    assert.equal(admin.last('admin').settings.locale, 'en');
  });

  test('keyboard players are named in the language of the moment they join', () => {
    const { game, admin } = newGame();
    admin.send({ t: 'settings', keyboardPlayers: true, locale: 'en' });
    const display = fakeClient(game);
    display.send({ t: 'hello', role: 'display' });
    display.send({ t: 'join', slot: 'wasd' });
    assert.equal(display.last('joined').name, 'Keyboard WASD');
    admin.send({ t: 'settings', locale: 'it' });
    display.send({ t: 'join', slot: 'arrows' });
    assert.equal(display.last('joined').name, 'Tastiera Frecce');
  });

  test('a reset to defaults keeps the language', () => {
    const { game, admin } = newGame();
    admin.send({ t: 'settings', locale: 'en', hats: false });
    admin.send({ t: 'resetSettings' });
    assert.equal(game.settings.hats, true);
    assert.equal(game.settings.locale, 'en');
  });
});

describe('language over http', () => {
  let app;
  let base;
  before(async () => {
    app = createApp({
      serverConfig: normalizeServerConfig({ adminPassword: 'test-password', wifi: { ssid: 'Expo', password: 'pw' } }),
      log: quiet,
    });
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${app.server.address().port}`;
  });
  after(() => app.close());

  const setLocale = (locale) => {
    const conn = app.game.connect({ send: () => {}, close: () => {} }, { admin: true, isAuthorized: () => true });
    conn.message(JSON.stringify({ t: 'settings', locale }));
  };

  test('/locale.js is the current language, never cached', async () => {
    let res = await fetch(`${base}/locale.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /javascript/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(await res.text(), 'export default "it";\n');
    setLocale('en');
    res = await fetch(`${base}/locale.js`);
    assert.equal(await res.text(), 'export default "en";\n');
    setLocale('it');
  });

  test('the login page is in the current language', async () => {
    let page = await (await fetch(`${base}/admin/login`)).text();
    assert.match(page, /<html lang="it">/);
    assert.ok(page.includes(stringsFor('it').login.title));
    setLocale('en');
    page = await (await fetch(`${base}/admin/login`)).text();
    assert.match(page, /<html lang="en">/);
    assert.ok(page.includes(stringsFor('en').login.submit));
    const wrong = await fetch(`${base}/admin/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: 'nope' }),
    });
    assert.equal(wrong.status, 401);
    assert.ok((await wrong.text()).includes(stringsFor('en').login.wrongPassword));
    setLocale('it');
  });
});
