// Theme contract: the palette must stay legible in both themes, and every
// token reference must resolve.
//
// This is the regression lock for two defect classes that shipped before and
// that nothing else caught — the build was green and every other test passed:
//   1. a light-on-white panel title (`#dbe2f2` hardcoded), and
//   2. `var(--err)`, a token that never existed, silently falling back to a
//      red that failed contrast on white.
//
// Pure CSS parsing and WCAG maths: no browser, no network, so it runs in CI.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  PROJECT_ROOT,
  readProjectFile,
  findTokens,
  declaredTokens,
  referencedTokens,
  tokenPairRatio,
} from './lib/theme-tokens.mjs';

// WCAG 2.1 AA for normal-size text. Status text, leads and links are all small.
const MIN_RATIO = 4.5;

const globalsCss = readProjectFile('app/globals.css');
const walletCss = readProjectFile('app/wallet/wallet.css');
const dashboardCss = readProjectFile('app/dashboard/dashboard.css');

/** Pairs that are actually rendered as text on that surface. */
const TEXT_ON_SURFACE = [
  ['fg', 'bg'],
  ['fg', 'surface'],
  ['fg', 'card'],
  ['muted', 'bg'],
  ['muted', 'surface'],
  ['muted', 'card'],
  ['link', 'bg'],
  ['link', 'surface'],
  ['link', 'card'],
  ['on-accent', 'accent'],
  ['ok', 'surface'],
  ['warn', 'surface'],
  ['danger', 'surface'],
];

const WALLET_PAIRS = TEXT_ON_SURFACE.map(([foreground, background]) => [
  foreground.replace('fg', 'text').replace('muted', 'text-dim'),
  background,
]);

function assertPairs(label, tokens, pairs) {
  for (const [foreground, background] of pairs) {
    const ratio = tokenPairRatio(tokens, foreground, background);
    assert.ok(
      ratio >= MIN_RATIO,
      `${label}: --${foreground} (${tokens[foreground]}) on --${background} (${tokens[background]}) is ${ratio.toFixed(2)}:1, below AA ${MIN_RATIO}:1`,
    );
  }
}

// A green suite that cannot fail is worse than no suite: pin the detectors.
test('the checks are not vacuous — known-bad input is flagged', () => {
  const failingTokens = findTokens(':root { --accent: #4c6fff; --on-accent: #ffffff; }', ':root');
  assert.ok(tokenPairRatio(failingTokens, 'on-accent', 'accent') < MIN_RATIO, 'the old accent must fail AA');

  const references = referencedTokens(':root { color: var(--err, #f87171); }');
  assert.deepEqual(references, [{ name: 'err', hasFallback: true }]);
});

test('site tokens are legible in the dark theme', () => {
  assertPairs('dark', findTokens(globalsCss, ':root'), TEXT_ON_SURFACE);
});

test('site tokens are legible in the light theme', () => {
  assertPairs('light', findTokens(globalsCss, "[data-theme='light']"), TEXT_ON_SURFACE);
});

test('wallet tokens are legible in the dark theme', () => {
  assertPairs('wallet dark', findTokens(walletCss, '.nw-root'), WALLET_PAIRS);
});

test('wallet tokens are legible in the light theme', () => {
  assertPairs(
    'wallet light',
    findTokens(walletCss, "[data-theme='light']", '.nw-root'),
    WALLET_PAIRS,
  );
});

test('the live console stays legible on its own dark surface', () => {
  assertPairs('console', findTokens(dashboardCss, '.nsx'), TEXT_ON_SURFACE);
});

// The extension popup loads wallet.css WITHOUT globals.css, so every bare
// `var(--x)` there must be declared in wallet.css itself.
test('wallet.css resolves its own bare token references (popup has no globals.css)', () => {
  const own = declaredTokens(walletCss);
  const missing = [
    ...new Set(
      referencedTokens(walletCss)
        .filter((reference) => !reference.hasFallback && !own.has(reference.name))
        .map((reference) => reference.name),
    ),
  ];
  assert.deepEqual(missing, [], `wallet.css uses undeclared tokens: ${missing.join(', ')}`);
});

// A literal fallback hides a typo: `var(--err, #f87171)` painted the fallback
// and looked intentional for months. Tokens must exist whether or not the call
// carries a fallback.
test('app stylesheets only reference tokens that exist', () => {
  const siteTokens = declaredTokens(globalsCss);
  const stylesheets = [
    ['app/globals.css', globalsCss],
    ['app/dashboard/dashboard.css', dashboardCss],
  ];

  for (const [file, css] of stylesheets) {
    const known = new Set([...siteTokens, ...declaredTokens(css)]);
    const missing = [
      ...new Set(
        referencedTokens(css)
          .filter((reference) => !known.has(reference.name))
          .map((reference) => reference.name),
      ),
    ];
    assert.deepEqual(missing, [], `${file} uses undeclared tokens: ${missing.join(', ')}`);
  }
});

// Inline styles in components are the exact place the `--err` bug lived; a
// stylesheet-only scan would not have seen it.
test('inline style tokens in app code exist in the palette', () => {
  const siteTokens = declaredTokens(globalsCss);
  const walletTokens = declaredTokens(walletCss);
  const files = [...walk(join(PROJECT_ROOT, 'app')), ...walk(join(PROJECT_ROOT, 'components'))].filter(
    (file) => file.endsWith('.js') || file.endsWith('.jsx'),
  );

  const problems = [];
  for (const file of files) {
    const relative = file.slice(PROJECT_ROOT.length + 1);
    const references = referencedTokens(readProjectFile(relative));
    for (const reference of references) {
      if (!siteTokens.has(reference.name) && !walletTokens.has(reference.name)) {
        problems.push(`${relative}: var(--${reference.name})`);
      }
    }
  }

  assert.deepEqual(problems, [], `inline styles reference undeclared tokens:\n${problems.join('\n')}`);
});

// Two files carry the palette on purpose (the popup cannot load globals.css).
// They must not drift: this is the check that catches "fixed it in one place".
// Only colour tokens are compared — radii, fonts and shadows may legitimately
// differ per surface — and the wallet renames two of them (text/text-dim).
const SHARED_PALETTE = [
  ['bg', 'bg'],
  ['surface', 'surface'],
  ['card', 'card'],
  ['fg', 'text'],
  ['muted', 'text-dim'],
  ['accent', 'accent'],
  ['accent-pressed', 'accent-pressed'],
  ['accent-tint', 'accent-tint'],
  ['on-accent', 'on-accent'],
  ['link', 'link'],
  ['ok', 'ok'],
  ['ok-tint', 'ok-tint'],
  ['warn', 'warn'],
  ['warn-tint', 'warn-tint'],
  ['danger', 'danger'],
  ['danger-tint', 'danger-tint'],
  ['card-grad', 'card-grad'],
];

test('globals.css and wallet.css agree on every shared colour token', () => {
  const compare = (label, globalsTokens, walletTokens) => {
    for (const [siteName, walletName] of SHARED_PALETTE) {
      assert.ok(siteName in globalsTokens, `${label}: globals.css does not declare --${siteName}`);
      assert.ok(walletName in walletTokens, `${label}: wallet.css does not declare --${walletName}`);
      assert.equal(
        squash(walletTokens[walletName]),
        squash(globalsTokens[siteName]),
        `${label}: the palette drifted — globals --${siteName} is ${globalsTokens[siteName]}, wallet --${walletName} is ${walletTokens[walletName]}`,
      );
    }
  };

  compare('dark', findTokens(globalsCss, ':root'), findTokens(walletCss, '.nw-root'));
  compare(
    'light',
    findTokens(globalsCss, "[data-theme='light']"),
    findTokens(walletCss, "[data-theme='light']", '.nw-root'),
  );
});

function squash(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

function walk(directory) {
  const out = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}
