const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const root = path.resolve(__dirname, '..');

// Load the actual TypeScript source without an extra test dependency.
function loader(overrides = {}) {
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
      module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
      resolveJsonModule: true, target: ts.ScriptTarget.ES2020,
    }}).outputText;
    const localRequire = name => {
      if (name in overrides) return overrides[name];
      if (name.endsWith('.css')) return {};
      if (name.startsWith('@/') || name.startsWith('.')) {
        const base = name.startsWith('@/') ? path.join(root, 'src', name.slice(2)) : path.resolve(path.dirname(file), name);
        if (base.endsWith('.json')) return JSON.parse(fs.readFileSync(base, 'utf8'));
        const target = [base, base+'.ts', base+'.tsx'].find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
        if (target) return load(target);
      }
      return require(name);
    };
    new Function('require', 'module', 'exports', code)(localRequire, module, module.exports);
    return module.exports;
  }
  return name => load(path.join(root, 'src', name));
}
const load = loader({ 'next/navigation': { usePathname: () => '/en/agent' } });
const { localePath, preferredLocale, translate, pageMetadata, localizedExample, LANGUAGE_STORAGE_KEY } = load('lib/i18n.ts');

test('language routes preserve query strings and fragments without rewriting APIs or external products', () => {
  assert.equal(localePath('/agent?from=home#tasks', 'en'), '/en/agent?from=home#tasks');
  assert.equal(localePath('/en/agent?from=home#tasks', 'zh'), '/agent?from=home#tasks');
  assert.equal(localePath('/en/agent', 'en'), '/en/agent');
  assert.equal(localePath('/#agent', 'en'), '/en#agent');
  for (const url of ['/api/account', '/geod', '/geod/cli', '/geod-site/logo.png', '/examples/henan-boundary.geojson', '//example.com/agent', 'https://example.com/agent', '#tasks']) {
    assert.equal(localePath(url, 'en'), url);
  }
});
test('manual preference wins; unsupported browser languages fall back to Chinese', () => {
  assert.equal(preferredLocale('zh', ['en-US']), 'zh');
  assert.equal(preferredLocale('en', ['zh-CN']), 'en');
  assert.equal(preferredLocale(null, ['fr-FR', 'en-GB']), 'en');
  assert.equal(preferredLocale(null, ['zh-Hant', 'en-US']), 'zh');
  assert.equal(preferredLocale('invalid', ['ja-JP']), 'zh');
});
test('pages without a translated route do not offer a language switch back to themselves', () => {
  for (const pathname of ['/geod', '/apply', '/admin/applications']) {
    const actual = loader({ 'next/navigation': { usePathname: () => pathname } })('app/_components/LocaleProvider.tsx');
    const html = renderToStaticMarkup(React.createElement(actual.LocaleProvider, { locale: 'zh' }, React.createElement(actual.LanguageSwitch)));
    assert.equal(html, '', pathname);
  }
});
test('static rendering translates UI, localizes links, and preserves user data and controls', () => {
  const { LocaleProvider, LocalizedContent } = load('app/_components/LocaleProvider.tsx');
  const html = renderToStaticMarkup(React.createElement(LocaleProvider, { locale: 'en' },
    React.createElement(LocalizedContent, null, React.createElement('section', null,
      React.createElement('h1', null, '影像下载'),
      React.createElement('a', { href: '/browser?returnTo=%2Fagent#download' }, '浏览器影像'),
      React.createElement('input', { placeholder: '我的影像图源', value: '影像下载', readOnly: true }),
      React.createElement('span', { 'data-no-translate': true }, '影像下载'),
      React.createElement('pre', null, React.createElement('code', null, '影像下载')),
    )),
  ));
  assert.match(html, /<h1>Imagery downloads<\/h1>/);
  assert.match(html, /href="\/en\/browser\?returnTo=%2Fagent#download"/);
  assert.match(html, /placeholder="My imagery source"/);
  assert.match(html, /value="影像下载"/);
  assert.match(html, /data-no-translate="true">影像下载/);
  assert.match(html, /<pre><code>影像下载<\/code><\/pre>/);
});
test('English metadata has language-specific title, canonical and alternate links', () => {
  const metadata = pageMetadata({ title: '历史版本', description: 'GeoD 正式发布版本、平台安装包与更新入口。' }, 'en', '/history');
  assert.equal(metadata.title, 'Release archive');
  assert.equal(metadata.alternates.canonical, '/en/history');
  assert.deepEqual(metadata.alternates.languages, { 'zh-CN': '/history', en: '/en/history', 'x-default': '/history' });
  assert.equal(pageMetadata({ title: { default: 'GeoD - GIS 桌面数据工作台', template: '%s | GeoD' } }, 'en', '/').title.default, 'GeoD - GIS Desktop Data Workspace');
});
test('English examples preserve line breaks, command syntax and JSON structure', () => {
  const example = 'geod auth login  # 下载 6 级及以上时，在浏览器完成授权\ngeod --version';
  assert.equal(localizedExample(example, 'en').split('\n').length, 2);
  assert.match(localizedExample(example, 'en'), /^geod auth login  # Authorize/);
  assert.equal(localizedExample(example, 'zh'), example);
  const json = '{"name":"Blue Marble 多级影像示例","sourceId":"nasa_gibs_blue_marble","zoom":5}';
  assert.equal(JSON.parse(localizedExample(json, 'en')).sourceId, 'nasa_gibs_blue_marble');
  assert.equal(translate('河南省界示例', 'en'), 'Henan province example');
  assert.equal(translate('影像下载', 'zh'), '影像下载');
  assert.equal(translate('。', 'en'), '.');
});
test('localized account return paths stay same-origin and reject unsafe redirects', () => {
  const { safeReturnTo } = load('lib/account.ts');
  const previous = global.window;
  global.window = { location: { origin: 'http://127.0.0.1:3401' } };
  try {
    assert.equal(safeReturnTo('?returnTo=%2Fen%2Fbrowser%23download'), '/en/browser#download');
    assert.equal(safeReturnTo('?returnTo=%2Fagent'), '/agent');
    for (const target of ['//example.com', '/\\example.com', 'https://example.com', '/en/api/account', '/unknown']) {
      assert.equal(safeReturnTo('?returnTo='+encodeURIComponent(target)), '/dashboard');
    }
  } finally { global.window = previous; }
});
test('first-visit selection and manual switching use real effect and click handlers', () => {
  let locale = 'zh', saved = null;
  const effects = [], replacements = [], stored = [];
  const fakeReact = { ...React, useEffect: effect => effects.push(effect), useContext: () => locale, useState: () => ['', () => {}] };
  const actual = loader({ react: fakeReact, 'next/navigation': { usePathname: () => global.location?.pathname ?? '/agent' } })('app/_components/LocaleProvider.tsx');
  const previous = ['localStorage', 'location', 'navigator', 'window'].map(name => [name, Object.getOwnPropertyDescriptor(global, name)]);
  Object.defineProperty(global, 'localStorage', { configurable: true, value: { getItem: () => saved, setItem: (...args) => stored.push(args) } });
  Object.defineProperty(global, 'navigator', { configurable: true, value: { languages: ['en-US'] } });
  Object.defineProperty(global, 'location', { configurable: true, value: { pathname: '/agent', search: '?from=home', hash: '#data', replace: target => replacements.push(target) } });
  Object.defineProperty(global, 'window', { configurable: true, value: { addEventListener() {}, removeEventListener() {} } });
  try {
    actual.LocaleProvider({ locale: 'zh', children: null }); effects.pop()();
    assert.deepEqual(replacements, ['/en/agent?from=home#data']);
    saved = 'zh'; replacements.length = 0;
    actual.LocaleProvider({ locale: 'zh', children: null }); effects.pop()();
    assert.deepEqual(replacements, []);
    actual.LocaleProvider({ locale: 'en', children: null }); effects.pop()();
    assert.deepEqual(replacements, []);
    const link = actual.LanguageSwitch();
    const event = { currentTarget: { href: '' } };
    link.props.onClick(event);
    assert.deepEqual(stored, [[LANGUAGE_STORAGE_KEY, 'en']]);
    assert.equal(event.currentTarget.href, '/en/agent?from=home#data');
    locale = 'en'; location.pathname = '/en/agent';
    actual.LanguageSwitch().props.onClick(event);
    assert.equal(event.currentTarget.href, '/agent?from=home#data');
  } finally {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(global, name, descriptor);
      else delete global[name];
    }
  }
});
