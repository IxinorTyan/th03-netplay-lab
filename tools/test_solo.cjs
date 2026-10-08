const assert=require('node:assert/strict');
const {readFileSync,existsSync,mkdirSync}=require('node:fs');
const {resolve}=require('node:path');
const {chromium}=require('C:/Users/14915/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:[chromium.executablePath(),'C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync)});
  try{
    for(const lang of ['jp','cn']){
      const context=await browser.newContext({viewport:{width:844,height:650},hasTouch:true});
      const page=await context.newPage(),errors=[],requests=[];
      page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push(r.url()));
      await page.route('**/solo.js',route=>route.fulfill({contentType:'text/javascript',body:readFileSync(resolve('web/solo.js'),'utf8')
        .replace('await emulator.addDiskImage(`3-${lang}.hdi`,disk);','window.soloTest={emulator,player,assist,loaded:disk.slice()};await emulator.addDiskImage(`3-${lang}.hdi`,disk);')}));
      await page.goto((process.env.TH03_URL||'http://127.0.0.1:9874')+'/solo.html');
      await page.locator('#runtime-mode').selectOption(process.env.SOLO_RUNTIME||'worker');await page.locator('#audio-mode').selectOption('original');await page.locator('#language').selectOption(lang);await page.locator('#start').click();
      await page.waitForFunction(()=>window.soloTest?.emulator.state==='running',null,{timeout:60000});
      await page.evaluate(()=>soloTest.player.enter({native:false}));
      const sourceMain=await page.evaluate(async()=>{const {Fat12,sha256}=await import('./disk.js');
        const disk=soloTest.assist.exportDisk(soloTest.loaded),fat=new Fat12(disk);return sha256(fat.read(fat.find('YUMEZIKU/MAIN.EXE')));});
      assert.equal(sourceMain,'f41fde47ea36bf4d985ff9127b67fe93d5ecb58cc36e7cffab86959db7f2ce6b');
      assert(!requests.some(url=>/np21-(60|lockstep)|native\/(music|start|game-)|bgm\//.test(url)),'Solo retains stock runtime, startup and music');
      await page.locator('.touch-help-open').click();
      for(const name of ['focus-enabled','focus-points','always-point','unlimited']){
        assert(await page.locator(`[data-${name}]`).isVisible());
        assert.equal(await page.locator(`[data-${name}]`).isChecked(),false);
      }
      await page.locator('[data-save]').click();
      await page.waitForTimeout(35000);
      // Capture actual SDL-bound events from the adapter while original DOS runs.
      await page.evaluate(()=>{window.soloEvents=[];for(const type of ['keydown','keyup'])document.getElementById('canvas').addEventListener(type,e=>soloEvents.push([type,e.code]));});
      const button=page.locator('[data-layout-control=fire]');
      const fire=await button.boundingBox();
      await page.mouse.move(fire.x+fire.width/2,fire.y+fire.height/2);await page.mouse.down();
      await page.waitForTimeout(150);
      await page.mouse.up();
      await page.waitForTimeout(80);
      assert(await page.evaluate(()=>soloEvents.some(e=>e[0]==='keydown'&&e[1]==='KeyZ')&&soloEvents.some(e=>e[0]==='keyup'&&e[1]==='KeyZ')));
      // Enter Story using original menu keys, without altering the boot or game mode.
      await page.locator('#canvas').focus();
      for(let attempt=0;attempt<45;attempt++){
        if(await page.evaluate(()=>soloTest.assist.bridge.markers().length>0))break;
        await page.keyboard.press('KeyZ',{delay:120});await page.waitForTimeout(1000);
        if(attempt%10===0)console.log(lang,'waiting for original Story',attempt);
      }
      await page.waitForFunction(()=>soloTest.assist.bridge.markers().length>0,null,{timeout:15000});
      await page.locator('.touch-help-open').click();
      for(const name of ['focus-enabled','focus-points','always-point','unlimited'])await page.locator(`[data-${name}]`).check();
      await page.locator('[data-save]').click();
      await page.waitForFunction(()=>!document.querySelector('.hit-points i').hidden);
      const before=await page.evaluate(()=>soloTest.assist.bridge.markers()[0]);
      const surface=await page.locator('.touch-surface').boundingBox();
      await page.mouse.move(surface.x+surface.width*.45,surface.y+surface.height*.55);await page.mouse.down();
      await page.mouse.move(surface.x+surface.width*.55,surface.y+surface.height*.55,{steps:2});
      await page.waitForTimeout(80);
      const after=await page.evaluate(()=>soloTest.assist.bridge.markers()[0]);
      await page.mouse.up();
      assert(after.x-before.x>40,JSON.stringify({before,after}));
      assert(after.x<=296,'Native field bounds still apply');
      await page.locator('#canvas').focus();await page.keyboard.down('Space');
      await page.waitForFunction(()=>soloTest.assist.bridge.markers()[0]?.focused);
      await page.keyboard.up('Space');
      await page.waitForFunction(()=>!soloTest.assist.bridge.markers()[0]?.focused);
      await page.locator('.touch-help-open').click();
      await page.locator('[data-always-point]').uncheck();await page.locator('[data-save]').click();
      await page.waitForFunction(()=>document.querySelector('.hit-points i').hidden);
      await page.locator('#canvas').focus();await page.keyboard.down('Space');
      await page.waitForFunction(()=>!document.querySelector('.hit-points i').hidden);
      await page.keyboard.up('Space');
      await page.locator('.touch-help-open').click();
      await page.locator('[data-focus-enabled]').uncheck();await page.locator('[data-save]').click();
      await page.locator('#canvas').focus();await page.keyboard.down('Space');await page.waitForTimeout(100);
      assert.equal(await page.evaluate(()=>soloTest.assist.bridge.markers()[0]?.focused),false);
      await page.keyboard.up('Space');
      assert.equal(await page.locator('[data-layout-control=focus]').isVisible(),false);
      await page.locator('.touch-help-open').click();
      await page.locator('[data-unlimited]').uncheck();await page.locator('[data-focus-points]').uncheck();
      await page.locator('[data-save]').click();
      await page.locator('#canvas').focus();await page.keyboard.press('Escape',{delay:150});await page.waitForTimeout(300);
      assert.equal(await page.evaluate(()=>soloTest.assist.bridge.markers().length),0,'Original pause blocks assists');
      await page.keyboard.press('Escape',{delay:150});
      await page.waitForFunction(()=>soloTest.assist.bridge.markers().length>0);
      assert.deepEqual(errors,[]);
      mkdirSync(resolve('reports/solo-check'),{recursive:true});await page.screenshot({path:resolve(`reports/solo-check/${lang}.png`),fullPage:true});
      console.log(`PASS ${lang}: original Story/runtime/music, clean exports, four optional assists, unlimited drag, focus off/on, local markers and original pause`);
      await context.close();
    }
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
