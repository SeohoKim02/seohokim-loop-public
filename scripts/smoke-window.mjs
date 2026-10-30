// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron } from 'playwright-core';

export const background = process.argv.includes('--background');

export async function launchDesktop(options) {
  if (!background) return _electron.launch(options);
  const profileArg = options.args.find((arg) => arg.startsWith('--user-data-dir='));
  assert.ok(profileArg, 'Background smoke requires an isolated profile.');
  const entry = path.join(profileArg.slice('--user-data-dir='.length), 'hidden-smoke.cjs');
  const original = options.args[0] === options.cwd
    ? path.join(options.cwd, 'dist-electron/electron/main.cjs') : options.args[0];
  await writeFile(entry, `const electron = require('electron');
const { app, BrowserWindow } = electron;
const Module = require('node:module');
BrowserWindow.prototype.show = function () {};
BrowserWindow.prototype.showInactive = function () {};
BrowserWindow.prototype.focus = function () {};
app.on('browser-window-created', (_event, window) => window.webContents.setBackgroundThrottling(false));
// Hidden native windows can yield stale/blank pixels on Windows. Use Electron's
// supported offscreen renderer for smoke captures, preserving all security prefs.
const testingElectron = Object.create(electron);
Object.defineProperty(testingElectron, 'BrowserWindow', { value: new Proxy(BrowserWindow, {
  construct(target, [options]) { return new target({ ...options, webPreferences: { ...options.webPreferences, offscreen: true } }); }
}) });
const load = Module._load;
Module._load = function (name, ...args) { return name === 'electron' ? testingElectron : load.call(this, name, ...args); };
require(${JSON.stringify(original)});
Module._load = load;
`);
  return _electron.launch({ ...options, args: [entry, ...options.args.slice(1)] });
}

export async function captureDesktop(desktop, page, options) {
  if (!background) return page.screenshot(options);
  // Wait for a freshly rendered offscreen frame, not a stale native backing
  // surface. This captures the viewport and never shows or focuses a window.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const png = await desktop.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window.isVisible()) throw new Error('Background smoke window became visible.');
    const contents = window.webContents;
    const image = await new Promise((resolve, reject) => {
      const painted = (_event, _rect, image) => { clearTimeout(timer); resolve(image); };
      const timer = setTimeout(() => { contents.removeListener('paint', painted); reject(new Error('Hidden render timed out.')); }, 5000);
      contents.once('paint', painted);
      contents.invalidate();
    });
    if (image.isEmpty()) throw new Error('Hidden capture returned no pixels.');
    const pixels = image.toBitmap();
    let dark = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 120 && pixels[i + 1] < 120 && pixels[i + 2] < 120) dark++;
    if (dark < 300) throw new Error('Hidden capture contains no readable content.');
    if (window.isVisible()) throw new Error('Capture activated the window.');
    return image.toPNG().toString('base64');
  });
  const buffer = Buffer.from(png, 'base64');
  if (options.path) await writeFile(options.path, buffer);
  return buffer;
}
