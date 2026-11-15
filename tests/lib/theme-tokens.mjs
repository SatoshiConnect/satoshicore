// Theme contract helpers: CSS custom-property extraction and WCAG contrast
// maths. No dependencies and no browser, so the checks run inside `npm test`
// and therefore in CI — that is the whole point of moving them here.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function readProjectFile(relativePath) {
  return readFileSync(join(PROJECT_ROOT, relativePath), 'utf8');
}

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Every rule block that has a body, flattened out of at-rule wrappers such as
 * @media. Token blocks in this project are plain rules, so a small scanner is
 * enough and avoids a CSS parser dependency.
 */
export function parseRules(css) {
  const source = stripComments(css);
  const rules = [];
  let buffer = '';
  let index = 0;

  while (index < source.length) {
    const char = source[index];

    if (char === '{') {
      const selector = buffer.trim();
      buffer = '';

      if (selector.startsWith('@')) {
        // At-rule wrapper: keep scanning; its inner rules are collected.
        index += 1;
        continue;
      }

      let depth = 1;
      let cursor = index + 1;
      let body = '';
      while (cursor < source.length && depth > 0) {
        const inner = source[cursor];
        if (inner === '{') depth += 1;
        else if (inner === '}') depth -= 1;
        if (depth > 0) body += inner;
        cursor += 1;
      }
      rules.push({ selector, body });
      index = cursor;
      continue;
    }

    if (char === '}') {
      buffer = '';
      index += 1;
      continue;
    }

    buffer += char;
    index += 1;
  }

  return rules;
}

/** Custom properties declared in one rule body, as a plain object. */
export function tokensOf(body) {
  const tokens = {};
  const pattern = /--([a-z0-9-]+)\s*:\s*([^;]+);/gi;
  let match = pattern.exec(body);
  while (match) {
    tokens[match[1]] = match[2].trim();
    pattern.lastIndex = match.index + match[0].length;
    match = pattern.exec(body);
  }
  return tokens;
}

/** Rules that declare custom properties, in source order. */
export function tokenRules(css) {
  return parseRules(css)
    .map(({ selector, body }) => ({ selector, tokens: tokensOf(body) }))
    .filter(({ tokens }) => Object.keys(tokens).length > 0);
}

/** First token rule whose selector contains every given fragment. */
export function findTokens(css, ...selectorFragments) {
  const rule = tokenRules(css).find((candidate) =>
    selectorFragments.every((fragment) => candidate.selector.includes(fragment)),
  );
  if (!rule) {
    throw new Error(`no token block whose selector contains ${selectorFragments.join(' + ')}`);
  }
  return rule.tokens;
}

/** Every token name declared anywhere in a stylesheet. */
export function declaredTokens(css) {
  const names = new Set();
  for (const { tokens } of tokenRules(css)) {
    for (const name of Object.keys(tokens)) names.add(name);
  }
  return names;
}

/** `var(--x)` usages, with whether each one carries a literal fallback. */
export function referencedTokens(css) {
  const source = stripComments(css);
  const found = [];
  const pattern = /var\(\s*--([a-z0-9-]+)\s*(,)?/gi;
  let match = pattern.exec(source);
  while (match) {
    found.push({ name: match[1], hasFallback: Boolean(match[2]) });
    pattern.lastIndex = match.index + match[0].length;
    match = pattern.exec(source);
  }
  return found;
}

function clampChannel(value) {
  return Math.min(255, Math.max(0, Math.round(value)));
}

/**
 * Resolve a CSS colour to { rgb: [r,g,b], a }. Returns null for anything that
 * is not a solid colour (gradients, font stacks, lengths, `currentColor`).
 */
export function parseColor(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();

  const hex = /^#([0-9a-f]{3,8})$/.exec(text);
  if (hex) {
    const digits = hex[1];
    const expand = (chunk) => parseInt(chunk.length === 1 ? chunk + chunk : chunk, 16);
    if (digits.length === 3 || digits.length === 4) {
      return {
        rgb: [expand(digits[0]), expand(digits[1]), expand(digits[2])],
        a: digits.length === 4 ? expand(digits[3]) / 255 : 1,
      };
    }
    if (digits.length === 6 || digits.length === 8) {
      return {
        rgb: [
          expand(digits.slice(0, 2)),
          expand(digits.slice(2, 4)),
          expand(digits.slice(4, 6)),
        ],
        a: digits.length === 8 ? expand(digits.slice(6, 8)) / 255 : 1,
      };
    }
    return null;
  }

  const rgb = /^rgba?\(([^)]+)\)$/.exec(text);
  if (rgb) {
    const parts = rgb[1]
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map((part) => (part.endsWith('%') ? (parseFloat(part) / 100) * 255 : parseFloat(part)));
    if (parts.length < 3 || parts.some((part) => Number.isNaN(part))) return null;
    return { rgb: parts.slice(0, 3).map(clampChannel), a: parts.length > 3 ? parts[3] : 1 };
  }

  return null;
}

/** Paint `over` on top of an opaque `base`, returning an opaque rgb triple. */
export function composite(over, base) {
  const alpha = over.a ?? 1;
  if (alpha >= 1) return over.rgb.slice();
  return over.rgb.map((channel, index) => clampChannel(channel * alpha + base[index] * (1 - alpha)));
}

function relativeLuminance([r, g, b]) {
  const linear = (channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG 2.1 contrast ratio between two colours (translucent fg is composited). */
export function contrastRatio(foreground, background) {
  const fg = typeof foreground === 'string' ? parseColor(foreground) : foreground;
  const bg = typeof background === 'string' ? parseColor(background) : background;
  if (!fg) throw new Error(`not a colour: ${foreground}`);
  if (!bg) throw new Error(`not a colour: ${background}`);

  const base = bg.a >= 1 ? bg.rgb.slice() : composite(bg, [255, 255, 255]);
  const fgRgb = composite(fg, base);

  const fgLum = relativeLuminance(fgRgb);
  const bgLum = relativeLuminance(base);
  const lighter = Math.max(fgLum, bgLum);
  const darker = Math.min(fgLum, bgLum);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Contrast for a pair of token names inside one token block. */
export function tokenPairRatio(tokens, foregroundName, backgroundName) {
  const foreground = tokens[foregroundName];
  const background = tokens[backgroundName];
  if (!foreground) throw new Error(`token --${foregroundName} is not declared`);
  if (!background) throw new Error(`token --${backgroundName} is not declared`);
  return contrastRatio(foreground, background);
}
