const assert=require('node:assert/strict');
const {existsSync,mkdirSync}=require('node:fs');
const {chromium}=require('C:/Users/14915/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:[chromium.executablePath(),'C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync)});
  const base=process.env.TH03_URL||'http://127.0.0.1:9874';
  const errors=[];mkdirSync('reports/network-touch',{recursive:true});
  const sample=page=>page.evaluate(async()=>{
    const values=[];for(let i=0;i<10;i++){values.push(testPlayer.sample()&32);testPlayer.consume();await new Promise(r=>setTimeout(r,20));}return values;
  });
  async function setup(context){
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/app.js',route=>route.fulfill({contentType:'text/javascript',body:
      "import {mountPlayer} from './player-ui.js';window.testPlayer=mountPlayer(document.getElementById('screen'),{solo:true,network:true});testPlayer.setActive(true);testPlayer.setContext({key:'round:1',play:true});testPlayer.enter({native:false});"}));
    await page.goto(base+'/local.html');await page.waitForFunction(()=>window.testPlayer);return page;
  }
  try{
    for(const viewport of [{width:390,height:844},{width:844,height:390}]){
      const context=await browser.newContext({viewport,hasTouch:true});const page=await setup(context);
      const rapid=page.locator('[data-rapid]'),shot=page.locator('[data-layout-control=fire]');
      assert.equal(await rapid.getAttribute('aria-pressed'),'true');
      const initial=await sample(page);assert(initial.includes(0)&&initial.includes(32));
      const bounds=await rapid.boundingBox();assert(bounds.x>=0&&bounds.y>=0&&bounds.x+bounds.width<=viewport.width&&bounds.y+bounds.height<=viewport.height);
      await rapid.tap();assert((await sample(page)).every(v=>v===0),'Off must stop automatic shots');
      await page.screenshot({path:`reports/network-touch/${viewport.width}-off.png`});
      // Manual charge must work with continuous fire off, and toggling must not release it.
      await shot.hover();await page.mouse.down();
      assert((await sample(page)).every(v=>v===32));
      await rapid.evaluate(n=>n.click());assert((await sample(page)).every(v=>v===32));
      await rapid.evaluate(n=>n.click());assert((await sample(page)).every(v=>v===32));
      await page.mouse.up();
      assert((await sample(page)).every(v=>v===0),'Manual release with autofire off must stay released');
      await page.reload();await page.waitForFunction(()=>window.testPlayer);
      assert.equal(await rapid.getAttribute('aria-pressed'),'false');
      await rapid.tap();
      await shot.hover();await page.mouse.down();await page.mouse.up();
      assert.equal(await page.evaluate(()=>testPlayer.sample()&32),0);
      await page.waitForTimeout(90);const resumed=await sample(page);assert(resumed.includes(0)&&resumed.includes(32));
      await page.evaluate(()=>testPlayer.setContext({key:'select:menu',play:false}));
      assert.equal(await rapid.isVisible(),false);assert((await sample(page)).every(v=>v===0));
      await page.evaluate(()=>testPlayer.setContext({key:'round:2',play:true}));
      await page.locator('.touch-help-open').click();
      await page.locator('[data-selected]').selectOption('rapid');await page.locator('[data-size]').fill('1.2');await page.locator('[data-save]').click();
      await page.reload();await page.waitForFunction(()=>window.testPlayer);
      assert.equal(await rapid.evaluate(n=>n.style.getPropertyValue('--control-scale')),'1.2');
      await rapid.tap();
      // A different browser retains its own default, never the first player's toggle.
      const other=await browser.newContext({viewport,hasTouch:true});const peer=await setup(other);
      assert.equal(await peer.locator('[data-rapid]').getAttribute('aria-pressed'),'true');
      await other.close();await context.close();
    }
    assert.deepEqual(errors,[]);console.log('PASS: online autofire toggle, charge/release, menus, local preference isolation and portrait/landscape layout persistence');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
