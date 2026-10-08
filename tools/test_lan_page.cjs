// Lobby integration. Set TH03_REAL_RUNTIME=1 to boot DOS instead of stubbing the iframe.
const assert = require('node:assert/strict');
const {mkdirSync, existsSync} = require('node:fs');
const {resolve} = require('node:path');
const {chromium} = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/14915/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

(async () => {
  const executablePath = process.env.CHROMIUM_PATH || [chromium.executablePath(),
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
  const browser = await chromium.launch({headless: true, executablePath});
  const output = resolve('reports/startup-check'); mkdirSync(output, {recursive: true});
  const base = process.env.TH03_URL || 'http://127.0.0.1:9869';
  const contexts = [await browser.newContext({viewport: {width: 1280, height: 900}}),
    await browser.newContext({viewport: {width: 390, height: 844}})];
  const pages = await Promise.all(contexts.map(c => c.newPage()));
  const errors = []; pages.forEach(page => page.on('pageerror', e => errors.push(e.message)));
  const real=process.env.TH03_REAL_RUNTIME==='1';
  try {
    for (const page of pages) {
      if(!real)await page.route('**/local.html?*', route => route.fulfill({contentType: 'text/html', body:
        '<!doctype html><html><body><p>Game runtime test stub</p><script>parent.postMessage({protocol:"th03-lan/1",event:"progress",message:"资源加载测试就绪",loaded:true},location.origin);</script></body></html>'}));
      await page.goto(base + '/index.html');
      assert.equal(await page.locator('.mode-card').count(),4);
      await page.screenshot({path:resolve(output,`launcher-${pages.indexOf(page)}.png`),fullPage:true});
      await page.goto(base + '/lan.html');
      await page.screenshot({path:resolve(output,`outside-${pages.indexOf(page)}.png`),fullPage:true});
    }
    const [host, guest] = pages;
    await host.locator('#connection-settings summary').click();
    await host.locator('#mode').selectOption('relay'); await host.locator('#create').click();
    await host.locator('#lobby').waitFor({state: 'visible'});
    const code = (await host.locator('#room-info').textContent()).match(/\d{4}/)[0];
    await guest.locator('#room').fill(code); await guest.locator('#join').click();
    await guest.locator('#lobby').waitFor({state: 'visible'});
    assert.equal(await guest.locator('#mode').inputValue(), 'relay');
    assert.equal(await host.locator('body').getAttribute('data-view'),'room');
    assert.equal(await host.locator('#entry').isVisible(),false);
    assert.equal(await host.locator('#host-seat').getAttribute('data-local'),'true');
    assert.equal(await guest.locator('#guest-seat').getAttribute('data-local'),'true');
    assert(await guest.locator('#language').isDisabled());
    await host.locator('#ready').click(); await guest.locator('#ready').click();
    await host.locator('#start').waitFor({state: 'visible'});
    await host.waitForFunction(() => !document.getElementById('start').disabled);
    assert(await guest.locator('#touch-unlimited-allowed').isDisabled());
    await host.locator('#touch-unlimited-allowed').uncheck();
    await guest.waitForFunction(()=>!document.getElementById('touch-unlimited-allowed').checked);
    await host.locator('#language').selectOption('cn');
    await host.waitForFunction(() => document.getElementById('start').disabled);
    await guest.waitForFunction(() => document.getElementById('language').value === 'cn' && document.getElementById('ready').textContent === '准备');
    await host.locator('#ready').click(); await guest.locator('#ready').click();
    await host.waitForFunction(() => !document.getElementById('start').disabled);
    for (const [i, page] of pages.entries()) {
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({path: resolve(output, i ? 'lobby-mobile.png' : 'lobby-desktop.png'), fullPage: true});
    }
    await host.locator('#start').click();
    for (const [i, page] of pages.entries()) {
      await page.locator('#game iframe').waitFor();
      await page.waitForFunction(message => document.getElementById('host-progress').textContent.includes(message)
        && document.getElementById('guest-progress').textContent.includes(message),real?'游戏已启动':'资源加载测试就绪',{timeout:120000});
      if(real){
        const frame=page.frames().find(frame=>frame.url().includes('local.html?'));
        await frame.waitForFunction(()=>window.th03SyncState?.frame>10,null,{timeout:60000});
        assert.equal(await frame.locator('.masthead').isVisible(),false);
        assert.equal(await frame.locator('.launch-settings').isVisible(),false);
        assert.equal(await frame.locator('.footer').isVisible(),false);
        const height=(await page.locator('#game iframe').boundingBox()).height;
        if(height>=1800)console.log('EMBEDDED LAYOUT',await frame.evaluate(()=>[...document.querySelector('main').children].map(node=>({tag:node.tagName,id:node.id,class:node.className,height:node.getBoundingClientRect().height,display:getComputedStyle(node).display}))));
        assert(height<1800);
        await page.screenshot({path:resolve(output,`playing-${i}.png`),fullPage:true});
      }
      const src = new URL(await page.locator('#game iframe').getAttribute('src'), base);
      assert.equal(src.searchParams.get('role'), i ? 'guest' : 'host');
      assert.equal(src.searchParams.get('language'), 'cn');
      assert.equal(src.searchParams.get('embedded'), '1');
      assert(new URL(page.url()).pathname.endsWith('/lan.html'));
      const gameFrame=page.frames().find(frame=>frame.url().includes('local.html?'));
      await gameFrame.evaluate(()=>parent.postMessage({protocol:'th03-lan/1',event:'view',immersive:true},location.origin));
      await page.waitForFunction(()=>document.querySelector('#game iframe').classList.contains('game-immersive'));
      const fullBounds=await page.locator('#game iframe').boundingBox();
      assert.equal(fullBounds.x,0);assert.equal(fullBounds.y,0);
      assert.equal(Math.round(fullBounds.width),page.viewportSize().width);
      assert.equal(Math.round(fullBounds.height),page.viewportSize().height);
      await gameFrame.evaluate(()=>parent.postMessage({protocol:'th03-lan/1',event:'view',immersive:false},location.origin));
      await page.waitForFunction(()=>!document.querySelector('#game iframe').classList.contains('game-immersive'));
    }
    assert.deepEqual(errors, []);
    await host.locator('#leave').click();
    await guest.waitForFunction(() => document.getElementById('game').children.length === 0);
    console.log(`PASS: desktop/mobile lobby, authoritative settings, readiness reset, inline autostart/progress and leave; ${real?'real synchronized runtimes':'runtime stubbed'}`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
