#!/usr/bin/env node
// Theme audit: real-browser contrast and layout check for every route.
//
// This is the counterpart to tests/theme-contrast.test.mjs. The test proves the
// token palette is legible; this script proves the composed pages are, because
// a rule can still paint text with the wrong token. It caught four shipped
// defects that no build, unit test or DOM assertion had noticed.
//
//   node scripts/theme-audit.mjs                       # both themes, live site
//   node scripts/theme-audit.mjs --base http://localhost:3000
//   node scripts/theme-audit.mjs --theme light --shots screenshots/theme
//   node scripts/theme-audit.mjs --json > audit.json
//
// Needs a Chrome/Chromium binary: CHROME_PATH, or one of the usual install
// locations. Read-only: it navigates and measures, and never touches the wallet.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DEFAULT_ROUTES = [
  '/',
  '/wallet/',
  '/docs/',
  '/download/',
  '/explorer/',
  '/dashboard/',
  '/status/',
  '/security/',
  '/terms/',
  '/privacy/',
];

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);

function parseArgs(argv) {
  const options = {
    base: 'https://satoshicore.org',
    theme: 'both',
    routes: DEFAULT_ROUTES,
    shots: null,
    json: false,
    width: 1440,
    height: 900,
    wait: 2200,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[index];
    };

    if (arg === '--base') options.base = next().replace(/\/$/, '');
    else if (arg === '--theme') options.theme = next();
    else if (arg === '--routes') options.routes = next().split(',').map((r) => r.trim()).filter(Boolean);
    else if (arg === '--shots') options.shots = next();
    else if (arg === '--width') options.width = Number(next());
    else if (arg === '--height') options.height = Number(next());
    else if (arg === '--wait') options.wait = Number(next());
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: node scripts/theme-audit.mjs [--base URL] [--theme light|dark|both] [--routes /,/wallet/] [--shots DIR] [--json]');
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }

  if (!['light', 'dark', 'both'].includes(options.theme)) {
    throw new Error('--theme must be light, dark or both');
  }
  return options;
}

function findChrome() {
  const found = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      'no Chrome/Chromium found. Set CHROME_PATH to the browser binary, e.g.\n' +
        '  CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node scripts/theme-audit.mjs',
    );
  }
  return found;
}

// ---------------------------------------------------------------- page probe

/**
 * Runs INSIDE the page (serialised with toString). Must stay self-contained.
 * Measures the composed page: real text nodes, their painted background with
 * translucent layers composited, and horizontal overflow.
 */
function auditPage(options) {
  const parseColor = (value) => {
    const text = String(value || '').trim().toLowerCase();
    if (text === 'transparent') return { rgb: [0, 0, 0], a: 0 };
    // color-mix() resolves to color(srgb 0..1 0..1 0..1 / a)
    if (text.startsWith('color(')) {
      const parts = (text.match(/[\d.]+/g) || []).map(Number);
      return { rgb: parts.slice(0, 3).map((v) => Math.round(v * 255)), a: parts.length > 3 ? parts[3] : 1 };
    }
    const numbers = (text.match(/[\d.]+/g) || []).map(Number);
    return { rgb: numbers.slice(0, 3), a: numbers.length > 3 ? numbers[3] : 1 };
  };

  const luminance = (rgb) => {
    const channel = (value) => {
      const c = value / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
  };

  const ratio = (a, b) => {
    const x = luminance(a);
    const y = luminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };

  // Composite every translucent background from <body> upwards, so a 5% tint
  // is measured against what the eye actually sees.
  const paintedBackground = (element) => {
    const chain = [];
    let node = element;
    while (node && node !== document.documentElement) {
      chain.push(parseColor(getComputedStyle(node).backgroundColor));
      node = node.parentElement;
    }
    chain.push(parseColor(getComputedStyle(document.body).backgroundColor));
    chain.push({ rgb: [255, 255, 255], a: 1 });

    // Bottom-up: the last entry is the white canvas, the element is painted last.
    let out = chain[chain.length - 1].rgb.slice();
    for (let index = chain.length - 2; index >= 0; index -= 1) {
      const { rgb, a } = chain[index];
      const base = out;
      out = rgb.map((channel, channelIndex) =>
        Math.round(channel * a + base[channelIndex] * (1 - a)),
      );
    }
    return out;
  };

  document.documentElement.dataset.theme = options.theme;

  const candidates = [
    ...document.querySelectorAll('h1, h2, h3, p, li, a, th, td, code, button, .page-meta, .panel-title, .page-eyebrow'),
  ];

  const samples = candidates.filter((element) => {
    if (!element.textContent || !element.textContent.trim()) return false;
    if (element.closest('[aria-hidden="true"]')) return false;
    const box = element.getBoundingClientRect();
    if (box.width < 4 || box.height < 4) return false;
    const style = getComputedStyle(element);
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.5;
  });

  const failures = [];
  let minRatio = 21;

  for (const element of samples.slice(0, 400)) {
    const style = getComputedStyle(element);
    const foreground = parseColor(style.color);
    const background = paintedBackground(element);
    const measured = ratio(foreground.rgb, background);

    const size = parseFloat(style.fontSize);
    const bold = Number(style.fontWeight) >= 600;
    const large = size >= 24 || (size >= 18.66 && bold);
    const needed = large ? 3 : 4.5;

    if (measured < minRatio) minRatio = measured;
    if (measured < needed) {
      failures.push({
        selector: element.tagName.toLowerCase() + (element.className ? `.${String(element.className).split(' ')[0]}` : ''),
        text: element.textContent.trim().slice(0, 48),
        ratio: Number(measured.toFixed(2)),
        needed,
      });
    }
  }

  return {
    theme: document.documentElement.dataset.theme,
    sampled: samples.length,
    minRatio: Number(minRatio.toFixed(2)),
    contrastFailures: failures.slice(0, 10),
    contrastFailureCount: failures.length,
    overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    height: document.documentElement.scrollHeight,
  };
}

// ------------------------------------------------------------------- browser

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function cdpClient(socket) {
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    }
  });
  return {
    send(method, params = {}) {
      nextId += 1;
      socket.send(JSON.stringify({ id: nextId, method, params }));
      return new Promise((resolve, reject) => pending.set(nextId, { resolve, reject }));
    },
  };
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  return { socket, client: cdpClient(socket) };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (typeof WebSocket !== 'function') {
    throw new Error(`the audit needs a Node with a global WebSocket (you have ${process.version}); use Node 21+`);
  }

  const chromePath = findChrome();
  const themes = options.theme === 'both' ? ['light', 'dark'] : [options.theme];
  const port = 9300 + Math.floor(Math.random() * 400);
  const profile = join(tmpdir(), `nsat-theme-audit-${port}`);

  if (options.shots) mkdirSync(options.shots, { recursive: true });

  const chrome = spawn(
    chromePath,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  let browser;
  let page;
  try {
    let version;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (response.ok) {
          version = await response.json();
          break;
        }
      } catch {
        // still starting
      }
      await sleep(150);
    }
    if (!version) throw new Error('Chrome did not expose a debugging endpoint');

    browser = await connect(version.webSocketDebuggerUrl);
    const { targetId } = await browser.client.send('Target.createTarget', { url: 'about:blank' });
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const target = targets.find((candidate) => candidate.id === targetId);
    page = await connect(target.webSocketDebuggerUrl);

    await page.client.send('Page.enable');
    await page.client.send('Runtime.enable');
    await page.client.send('Emulation.setDeviceMetricsOverride', {
      width: options.width,
      height: options.height,
      deviceScaleFactor: 1,
      mobile: false,
    });

    const results = [];
    for (const theme of themes) {
      for (const route of options.routes) {
        const url = `${options.base}${route}`;
        await page.client.send('Page.navigate', { url });
        await sleep(options.wait);
        // Pin the theme after navigation: the inline head script reads storage.
        await page.client.send('Runtime.evaluate', {
          expression: `document.documentElement.dataset.theme = ${JSON.stringify(theme)}; try { localStorage.setItem('nsat-theme', ${JSON.stringify(theme)}); } catch (error) {}`,
        });
        await sleep(400);

        const { result } = await page.client.send('Runtime.evaluate', {
          expression: `(${auditPage.toString()})(${JSON.stringify({ theme })})`,
          returnByValue: true,
        });
        const audit = result.value;

        if (options.shots) {
          const metrics = await page.client.send('Page.getLayoutMetrics');
          const height = Math.min((metrics.cssContentSize || metrics.contentSize).height, 4200);
          const shot = await page.client.send('Page.captureScreenshot', {
            format: 'png',
            captureBeyondViewport: true,
            clip: { x: 0, y: 0, width: options.width, height, scale: 1 },
          });
          const name = route === '/' ? 'home' : route.replace(/\//g, '');
          writeFileSync(join(options.shots, `${theme}-${name}.png`), Buffer.from(shot.data, 'base64'));
        }

        const failed = audit.contrastFailureCount > 0 || audit.overflowX;
        results.push({ theme, route, url, failed, ...audit });
      }
    }

    if (options.json) {
      console.log(JSON.stringify({ base: options.base, generatedAt: new Date().toISOString(), results }, null, 2));
    } else {
      let failures = 0;
      for (const theme of themes) {
        console.log(`\n${theme.toUpperCase()}`);
        for (const result of results.filter((entry) => entry.theme === theme)) {
          const state = result.failed ? 'FAIL' : ' ok ';
          console.log(
            `  [${state}] ${result.route.padEnd(12)} min ${String(result.minRatio).padEnd(5)} nodes ${String(result.sampled).padStart(3)}${result.overflowX ? `  OVERFLOW ${result.scrollWidth} > ${result.innerWidth}` : ''}`,
          );
          for (const failure of result.contrastFailures) {
            console.log(`         ${failure.ratio}:1 < ${failure.needed}  ${failure.selector} "${failure.text}"`);
          }
          if (result.failed) failures += 1;
        }
      }
      console.log(
        `\n${results.length} page checks — ${results.length - failures} passed, ${failures} failed (base ${options.base})`,
      );
      if (failures > 0) process.exitCode = 1;
    }

    if (options.json && results.some((result) => result.failed)) process.exitCode = 1;
  } finally {
    page?.socket.close();
    browser?.socket.close();
    chrome.kill('SIGTERM');
    try {
      // Chrome can still be flushing its profile when the process is signalled.
      rmSync(profile, { recursive: true, force: true });
    } catch {
      // A leftover temp profile is harmless; never fail the audit over it.
    }
  }
}

main().catch((error) => {
  console.error(`theme audit failed: ${error.message}`);
  process.exitCode = error.message.startsWith('no Chrome') ? 2 : 1;
});
