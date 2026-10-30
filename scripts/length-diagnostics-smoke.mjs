// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';
import { launchDesktop, captureDesktop } from './smoke-window.mjs';
import { historySnapshot } from '../src/domain/loop-history.ts';

// Fake transport only. No --live path exists in this script.
const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const development = process.argv.includes('--dev');
const sources = process.argv.includes('--sources');
const guidance = process.argv.includes('--guidance') || sources;
const multiple = process.argv.includes('--multiple') || guidance;
const mode = development ? 'development' : 'production';
const artifacts = path.join(root, 'artifacts', sources ? 'task35' : guidance ? 'task34' : multiple ? 'task33' : 'task32');
await mkdir(artifacts, { recursive: true });
const directory = await mkdtemp(path.join(tmpdir(), 'seohokim-length-smoke-'));
const profile = path.join(directory, 'profile');
await mkdir(profile);
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith('SEOHOKIM_LOOP_') || /API_KEY/.test(key) || key === 'ELECTRON_RUN_AS_NODE') delete env[key];
let calls = 0; let fail = false;
const raw = '  # 가😀\r\n나  ';
const errors = []; const checks = [];
const api = createServer(async (request, response) => {
  try {
    calls++;
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.headers.authorization, 'Bearer fake-length-key');
    let body = ''; for await (const chunk of request) body += chunk;
    assert.ok(!body.includes('fake-length-key'));
    if (fail) { response.writeHead(401); response.end('{}'); return; }
    const planning = JSON.parse(body).messages[0].content.includes('작업 계획 준비');
    const output = planning ? JSON.stringify({ title: '분량 진단 회귀', steps: [
      { title: '초안', role: 'write', objective: '초안 작성', usesPreviousOutputs: false, dependsOn: [], isFinal: false },
      { title: '최종 정리', role: 'deliver', objective: '최종 정리', usesPreviousOutputs: true, dependsOn: [1], isFinal: true },
    ] }) : raw;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { content: output } }] }));
  } catch { errors.push('Invalid fake request'); response.writeHead(500); response.end('{}'); }
});
await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${api.address().port}`;
Object.assign(env, { SEOHOKIM_LOOP_OPENAI_API_KEY: 'fake-length-key', SEOHOKIM_LOOP_OPENAI_BASE_URL: `${base}/v1`, SEOHOKIM_LOOP_OPENAI_MODEL: 'fake-length-model' });
let desktop; let vite; let page;
const button = () => page.getByRole('button', { name: '분량 확인', exact: true });
const result = () => page.getByTestId('length-result');
const nav = name => page.getByRole('navigation').getByRole('button', { name, exact: true }).click();
const snapshot = () => page.evaluate(() => {
  const node = document.querySelector('.work-grid');
  let fiber = node[Object.keys(node).find(key => key.startsWith('__reactFiber$'))];
  while (fiber.return) fiber = fiber.return;
  const pending = [fiber.stateNode.current];
  while (pending.length) {
    const current = pending.pop();
    if (current.memoizedProps?.loop) return JSON.parse(JSON.stringify(current.memoizedProps.loop));
    if (current.child) pending.push(current.child); if (current.sibling) pending.push(current.sibling);
  }
  throw new Error('Loop snapshot unavailable');
});
const detail = async id => {
  const reply = await page.evaluate(id => window.seohoKimLoop.getHistory(id), id);
  assert.equal(reply.ok, true); return reply.value;
};
const completed = async () => {
  await page.locator('[data-testid="loop"][data-status="completed"]').waitFor({ timeout: 15000 });
  await page.getByText('기록에 보관되었습니다.', { exact: true }).waitFor();
};
const start = async (request, provider = 'mock', execution = 'single') => {
  await page.locator('#execution-mode').selectOption(execution);
  if (execution !== 'auto') await page.locator('#provider').selectOption(provider);
  if (execution === 'collaboration') await page.locator('#reviewer').selectOption('mock');
  await page.locator('#request').fill(request);
  await page.getByRole('button', { name: 'Start Loop', exact: true }).click();
};
const diagnose = async verdict => {
  const loop = await snapshot(); const history = await detail(loop.id); const beforeCalls = calls;
  const folder = path.join(profile, 'loop-history');
  const files = await readdir(folder);
  const encrypted = await Promise.all(files.map(file => readFile(path.join(folder, file))));
  await button().click();
  assert.equal(await result().getAttribute('data-verdict'), verdict);
  await button().click();
  assert.deepEqual(await snapshot(), loop);
  assert.equal(await page.getByTestId('final-result').textContent(), loop.finalResult);
  assert.deepEqual(await detail(loop.id), history);
  assert.deepEqual(history, historySnapshot(loop));
  assert.deepEqual(await readdir(folder), files);
  assert.deepEqual(await Promise.all(files.map(file => readFile(path.join(folder, file)))), encrypted);
  assert.equal(calls, beforeCalls);
};
const showSources = async (expected, kinds) => {
  const loop = await snapshot(); const history = await detail(loop.id); const beforeCalls = calls;
  const folder = path.join(profile, 'loop-history'); const files = await readdir(folder);
  const encrypted = await Promise.all(files.map(file => readFile(path.join(folder, file))));
  const disclosure = page.getByTestId('length-source'); const text = page.getByTestId('length-source-text');
  assert.equal(await disclosure.getAttribute('open'), null);
  assert.equal(await text.isVisible(), false);
  await disclosure.locator('summary').click();
  assert.equal(await text.textContent(), loop.userRequest);
  assert.deepEqual(await text.locator('mark').allTextContents(), expected);
  if (kinds) assert.deepEqual(await text.locator('mark').evaluateAll(nodes => nodes.map(node => node.dataset.kind)), kinds);
  assert.equal(await text.locator('script,img,a,iframe').count(), 0);
  assert.equal(await text.innerText().then(value => value.includes('fake-length-key')), false);
  assert.deepEqual(await snapshot(), loop); assert.deepEqual(await detail(loop.id), history);
  assert.deepEqual(await readdir(folder), files);
  assert.deepEqual(await Promise.all(files.map(file => readFile(path.join(folder, file)))), encrypted);
  assert.equal(calls, beforeCalls);
  assert.equal(await page.getByTestId('final-result').textContent(), loop.finalResult);
  assert.equal(await text.evaluate(node => node.scrollWidth <= node.clientWidth), true);
};
try {
  if (development) { vite = await (await import('vite')).createServer(); await vite.listen(); }
  desktop = await launchDesktop({ executablePath: electronPath, args: [root, ...(development ? ['--dev'] : []), `--user-data-dir=${profile}`], cwd: root, env, timeout: 30000 });
  page = await desktop.firstWindow();
  page.on('pageerror', () => errors.push('Renderer error'));
  page.on('request', request => { if (!request.url().startsWith('file:') && !request.url().startsWith('http://127.0.0.1:')) errors.push('Unexpected renderer request'); });
  await page.getByRole('heading', { name: '할 일을 적으면, Loop가 이어갑니다.' }).waitFor();
  await desktop.evaluate((_electron, base) => {
    const transport = globalThis.fetch;
    globalThis.fetch = (url, options) => {
      if (!String(url).startsWith(`${base}/`)) throw new Error('Non-fixture transport blocked');
      return transport(url, options);
    };
  }, base);
  const security = await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
  assert.equal(security.contextIsolation, true); assert.equal(security.nodeIntegration, false); assert.equal(security.sandbox, true);
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  assert.equal(await page.evaluate(() => typeof window.process), 'undefined');
  assert.equal(await button().count(), 0);

  for (const [request, verdict] of [
    ['최소 10000자로 작성해줘.', 'under'], ['최대 1자로 작성해줘.', 'over'],
    ['1~10000자로 작성해줘.', 'satisfied'], ['짧게 작성해줘.', 'unavailable'],
  ]) {
    await start(request);
    await page.locator('[data-testid="loop"][data-status="running"]').waitFor();
    assert.equal(await button().count(), 0); assert.equal(await result().count(), 0);
    await completed(); assert.equal(await result().count(), 0);
    await diagnose(verdict);
    assert.equal(calls, 0);
    checks.push(`Mock Single: ${request}, ${verdict}, raw/status/history unchanged, zero transport`);
  }
  if (guidance) assert.equal(await page.getByTestId('length-guidance').innerText(), '요청에서 글자 수 조건을 찾지 못했습니다.');
  for (const [request, verdict] of [
    ['정확히 6자로 작성해줘.', 'satisfied'], ['최소 7자로 작성해줘.', 'under'], ['최대 5자로 작성해줘.', 'over'],
    ['"최소 100자"를 요약해줘.', 'unavailable'], ['최소 10자 최대 5자로 작성해줘.', 'unavailable'],
  ]) {
    const before = calls;
    await start(request, 'openai-compatible'); await completed();
    assert.equal(await result().count(), 0);
    assert.equal((await snapshot()).finalResult, raw);
    await diagnose(verdict); assert.equal(calls, before + 1);
  }
  checks.push('Fake HTTP: exact Unicode/CRLF length, under/over/quoted/conflicting conditions; one execution only');
  if (multiple) {
    await start('최소 1자, 최대 10000자로 작성해줘.'); await completed();
    const beforeMock = calls;
    await diagnose('satisfied'); assert.equal(calls, beforeMock);
    assert.match(await result().innerText(), /요청한 분량: 1~10000자/);
    checks.push('Mock Single combines minimum and maximum without any diagnostic model call');
    for (const [request, verdict, expected] of [
      ['최소 3자, 최대 8자로 작성해줘.', 'satisfied', '요청한 분량: 3~8자'],
      ['1~10자, 3~8자로 작성해줘.', 'satisfied', '요청한 분량: 3~8자'],
      ['정확히 6자, 1~10자로 작성해줘.', 'satisfied', '요청한 분량: 정확히 6자'],
      ['정확히 6자, 정확히 6자로 작성해줘.', 'satisfied', '요청한 분량: 정확히 6자'],
      ['최소 7자, 최대 10자로 작성해줘.', 'under', '최소 기준보다 1자 부족합니다.'],
      ['최소 3자, 최대 5자로 작성해줘.', 'over', '최대 기준보다 1자 초과합니다.'],
      ['최소 10자, 최대 5자로 작성해줘.', 'unavailable', '요청한 글자 수 조건이 서로 충돌합니다.'],
      ['정확히 5자, 정확히 6자로 작성해줘.', 'unavailable', '요청한 글자 수 조건이 서로 충돌합니다.'],
      ['최소 3자 또는 최대 8자로 작성해줘.', 'unavailable', '글자 수 조건을 확정할 수 없습니다.'],
      ['최소 3자, 8글자 미만으로 작성해줘.', 'unavailable', '현재는 자 단위의 글자 수 조건만 확인할 수 있습니다.'],
      ['3자 이상 쓰지 마. 최대 8자로 작성해줘.', 'unavailable', '글자 수 조건을 확정할 수 없습니다.'],
    ]) {
      const before = calls;
      await start(request, 'openai-compatible'); await completed();
      assert.equal(await result().count(), 0);
      await diagnose(verdict); assert.equal(calls, before + 1);
      assert.ok((await result().innerText()).includes(expected));
      if (verdict !== 'unavailable') assert.match(await result().innerText(), /실제 결과: 6자/);
    }
    checks.push('Multiple bounds/ranges/exact/duplicates/intersections, conflicts and uncertain instructions; exact Unicode counts and intact raw/history');

    // Conflict is also an ordinary completed result: export and History stay usable.
    await start('최소 10자, 최대 5자로 작성해줘.', 'openai-compatible'); await completed(); await diagnose('unavailable');
    const conflict = await snapshot(); const before = calls; const filePath = path.join(directory, '충돌 원본.md');
    await desktop.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, filePath);
    await page.getByRole('button', { name: 'Markdown 저장', exact: true }).click();
    await page.getByText('파일이 저장되었습니다.', { exact: true }).waitFor();
    assert.deepEqual(await readFile(filePath), Buffer.from(raw)); assert.deepEqual(await snapshot(), conflict);
    await nav('기록');
    await page.locator(`[data-history-id="${conflict.id}"]`).getByRole('button', { name: '기록 열기', exact: true }).click();
    await page.getByTestId('history-detail').waitFor();
    assert.equal(await page.getByTestId('history-detail').getByTestId('final-result').textContent(), raw);
    await nav('Loop'); assert.equal(calls, before);
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(860, 640));
    await button().scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await result().evaluate(node => node.scrollWidth <= node.clientWidth), true);
    await captureDesktop(desktop, page, { path: path.join(artifacts, `${mode}-length-conflict.png`) });
    checks.push('Conflicting completed result still exports exact bytes, opens History and fits minimum window');
  }
  if (guidance) {
    for (const [request, expected, help] of [
      ['최소 10자, 최대 5자로 작성해줘.', '요청한 글자 수 조건이 서로 충돌합니다.', '결합한 최소 글자 수가 최대 글자 수보다 큽니다.'],
      ['정확히 5자, 정확히 6자로 작성해줘.', '요청한 글자 수 조건이 서로 충돌합니다.', '서로 다른 정확한 글자 수가 요청되었습니다.'],
      ['10~5자로 작성해줘.', '최소 글자 수가 최대 글자 수보다 큽니다.', undefined],
      ['최대 1.5자로 작성해줘.', '글자 수 조건의 숫자를 확인해주세요.', '0 이상의 정수로 적어주세요. 너무 큰 수와 음수·소수·쉼표·지수 표기는 지원하지 않습니다.'],
      ['3자 이상 쓰지 마.', '부정·선택 또는 모호한 표현이 있어 글자 수 조건을 확정할 수 없습니다.', undefined],
      ['3자 미만으로 작성해줘.', '현재 지원하지 않는 글자 수 표현입니다.', '최소 100자, 최대 200자처럼 명확한 조건으로 적어주세요.'],
      ['최대 3단어로 작성해줘.', '현재는 자 단위의 글자 수 조건만 확인할 수 있습니다.', '단어나 바이트 수는 글자 수로 바꾸어 계산하지 않습니다.'],
      ['"최소 3자"를 요약해줘.', '인용·자료 표현이 있어 실제 작성 지시와 글자 수 조건을 구분할 수 없습니다.', undefined],
      ['[최소 3자]', '글자 수 조건을 명확하게 확인할 수 없습니다.', undefined],
      ['버전 1.5 안내를 최소 3자로 작성해줘.', '글자 수 조건을 명확하게 확인할 수 없습니다.', undefined],
    ]) {
      const before = calls;
      await start(request, 'openai-compatible'); await completed();
      assert.equal(await result().count(), 0);
      assert.equal(await page.getByTestId('length-guidance').count(), 0);
      await diagnose('unavailable'); assert.equal(calls, before + 1);
      assert.equal(await page.getByTestId('length-guidance').innerText(), expected);
      if (help) assert.equal(await page.getByTestId('length-guidance-help').innerText(), help);
      else assert.equal(await page.getByTestId('length-guidance-help').count(), 0);
      assert.doesNotMatch(await result().innerText(), /API|Parser|Validator|uncertain|invalid|conflict|stack/i);
      await button().scrollIntoViewIfNeeded();
      assert.equal(await result().evaluate(node => node.scrollWidth <= node.clientWidth), true);
      if (request === '최대 1.5자로 작성해줘.') await captureDesktop(desktop, page, { path: path.join(artifacts, `${mode}-guidance-number.png`) });
    }
    checks.push('Evidence-based guidance: none/conflict/bounds/exact/number/unit/unsupported/negative/quote/generic; no invented date error, no internal codes');
    checks.push('Guidance reset on each new Loop; original/History bytes and execution counts unchanged; 860x640 text fits');
  }
  if (sources) {
    page.on('dialog', async dialog => { errors.push('Unexpected script/dialog execution'); await dialog.dismiss(); });
    await start('최소 1자, 최대 10000자로 작성해줘.');
    await page.locator('[data-testid="loop"][data-status="running"]').waitFor();
    assert.equal(await page.getByTestId('length-source').count(), 0);
    await completed(); await diagnose('satisfied');
    const beforeMock = calls;
    await showSources(['최소 1자', '최대 10000자'], ['minimum', 'maximum']);
    assert.equal(calls, beforeMock);
    checks.push('Mock Single: collapsed source disclosure, exact marked phrases, no extra transport');
    for (const [request, verdict, expected, kinds] of [
      ['최소 3자로 작성해줘.', 'satisfied', ['최소 3자'], ['minimum']],
      ['최대 5자로 작성해줘.', 'over', ['최대 5자'], ['maximum']],
      ['3~10자, 최소 5자로 작성해줘.', 'satisfied', ['3~10자', '최소 5자'], ['range', 'minimum']],
      ['정확히 6자, 1~10자로 작성해줘.', 'satisfied', ['정확히 6자', '1~10자'], ['exact', 'range']],
      ['최소 3자, 최소 3자, 최대 10자로 작성해줘.', 'satisfied', ['최소 3자', '최소 3자', '최대 10자'], ['minimum', 'minimum', 'maximum']],
      ['최소 10자, 최대 5자로 작성해줘.', 'unavailable', ['최소 10자', '최대 5자'], ['minimum', 'maximum']],
      ['javascript:alert(1) 😀 & (공지)\r\n최소 3자, 최대 10자로 작성해줘.', 'satisfied', ['최소 3자', '최대 10자'], ['minimum', 'maximum']],
    ]) {
      const before = calls;
      await start(request, 'openai-compatible'); await completed();
      assert.equal(await page.getByTestId('length-source').count(), 0);
      await diagnose(verdict); await showSources(expected, kinds); assert.equal(calls, before + 1);
      const text = page.getByTestId('length-source-text'); await text.scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      if (request.startsWith('javascript:')) await captureDesktop(desktop, page, { path: path.join(artifacts, `${mode}-source-unicode.png`) });
      if (verdict === 'unavailable') await captureDesktop(desktop, page, { path: path.join(artifacts, `${mode}-source-conflict.png`) });
    }
    checks.push('Single/min/max/range/exact/repeated/conflicting phrases and Unicode/newlines preserved; text-only source rendering at 860x640');
    const beforeSourceSave = calls; const sourceLoop = await snapshot(); const sourceExport = path.join(directory, '원문 표시 후 저장.md');
    await desktop.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, sourceExport);
    await page.getByRole('button', { name: 'Markdown 저장', exact: true }).click();
    await page.getByText('파일이 저장되었습니다.', { exact: true }).waitFor();
    assert.deepEqual(await readFile(sourceExport), Buffer.from(raw)); assert.deepEqual(await snapshot(), sourceLoop);
    await nav('기록');
    await page.locator(`[data-history-id="${sourceLoop.id}"]`).getByRole('button', { name: '기록 열기', exact: true }).click();
    await page.getByTestId('history-detail').waitFor();
    assert.equal(await page.getByTestId('history-detail').getByTestId('final-result').textContent(), raw);
    assert.equal(await page.getByTestId('history-detail').getByTestId('length-source').count(), 0);
    await nav('Loop');
    assert.equal(await page.getByTestId('length-source-text').textContent(), sourceLoop.userRequest);
    assert.equal(calls, beforeSourceSave);
    for (const request of ['"최소 3자"를 요약해줘.', '최소 3자 이상 쓰지 마.', '3자 미만으로 작성해줘.',
      '최소 3자, 10글자로 작성해줘.', '10~3자로 작성해줘.',
      '<script>window.sourceExecuted=true</script> 최소 3자로 작성해줘.',
      '<img src=x onerror=alert(1)> 최소 3자로 작성해줘.']) {
      const before = calls;
      await start(request, 'openai-compatible'); await completed(); await diagnose('unavailable');
      assert.equal(await page.getByTestId('length-source').count(), 0);
      assert.equal(await page.evaluate(() => typeof window.sourceExecuted), 'undefined');
      assert.equal(await page.locator('.request-preview script,.request-preview img,.length-diagnostics script,.length-diagnostics img').count(), 0);
      assert.equal(calls, before + 1);
    }
    checks.push('Uncertain/quoted/negative/invalid/HTML input has no invented highlights or execution; disclosure leaves History/export intact');
  }
  await start('최소 7자로 작성해줘.', 'openai-compatible'); await completed(); await diagnose('under');
  await page.locator('#request').fill('최대 1자로 작성해줘.');
  await button().click(); assert.match(await result().innerText(), /요청한 분량: 최소 7자/);
  await page.locator('#execution-mode').selectOption('auto');
  assert.equal(await button().count(), 1); // Actual completed Loop, not the next run's dropdown.
  const loop = await snapshot();
  const exportPath = path.join(directory, '원본.md');
  await desktop.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, exportPath);
  const beforeExport = calls;
  await page.getByRole('button', { name: 'Markdown 저장', exact: true }).click();
  await page.getByText('파일이 저장되었습니다.', { exact: true }).waitFor();
  assert.deepEqual(await readFile(exportPath), Buffer.from(raw)); assert.equal(calls, beforeExport);
  await nav('기록');
  await page.locator(`[data-history-id="${loop.id}"]`).getByRole('button', { name: '기록 열기', exact: true }).click();
  await page.getByTestId('history-detail').waitFor();
  assert.equal(await page.getByTestId('history-detail').getByTestId('final-result').textContent(), raw);
  assert.equal(await page.getByTestId('history-detail').getByRole('button', { name: '분량 확인', exact: true }).count(), 0);
  await nav('Connections'); assert.equal(await page.getByTestId('connection-card').count(), 5);
  await nav('Loop'); assert.equal(await result().getAttribute('data-verdict'), 'under');
  checks.push('Editing next input/mode cannot retarget diagnosis; History detail/export/navigation preserved');

  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(860, 640));
  await button().scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  const layout = await page.locator('.length-diagnostics').evaluate(node => {
    const r = node.getBoundingClientRect(); const parent = node.closest('.result-card').getBoundingClientRect();
    return { fits: r.left >= parent.left && r.right <= parent.right, textSize: getComputedStyle(node.querySelector('p')).fontSize };
  });
  assert.equal(layout.fits, true); assert.equal(layout.textSize, '15px');
  await captureDesktop(desktop, page, { path: path.join(artifacts, `${mode}-length-minimum.png`) });
  checks.push('860x640 minimum window: no horizontal overflow, diagnosis contained in result card');

  await start('최소 100자로 작성해줘.');
  await page.locator('[data-testid="loop"][data-status="running"]').waitFor();
  assert.equal(await result().count(), 0); assert.equal(await button().count(), 0);
  await page.getByRole('button', { name: '작업 중지', exact: true }).click();
  await page.locator('[data-testid="loop"][data-status="cancelled"]').waitFor();
  assert.equal(await button().count(), 0);
  fail = true; await start('최소 100자로 작성해줘.', 'openai-compatible');
  await page.locator('[data-testid="loop"][data-status="failed"]').waitFor();
  assert.equal(await button().count(), 0); fail = false;
  checks.push('New Loop resets diagnostic; running/cancelled/failed results have no button');
  for (const execution of ['auto', 'collaboration']) {
    await start('최소 100자로 작성해줘.', 'openai-compatible', execution); await completed();
    assert.equal(await button().count(), 0); assert.equal(await result().count(), 0);
    assert.equal(await page.getByTestId('length-source').count(), 0);
  }
  checks.push('Auto and Manual Collaboration still complete and save History; diagnostics excluded');
  assert.equal(await page.locator('body').innerText().then(text => text.includes('fake-length-key')), false);
  assert.deepEqual(errors, []);
  await writeFile(path.join(artifacts, `${mode}-length.json`), JSON.stringify({ passed: true, mode, checks, fakeHttpRequests: calls, realModelRequests: 0 }, null, 2));
  console.log(`${mode}: ${checks.length} length diagnostic Desktop checks passed; real models 0`);
} finally {
  await desktop?.close(); await vite?.close();
  api.closeAllConnections(); await new Promise(resolve => api.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
