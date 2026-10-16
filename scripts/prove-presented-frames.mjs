// Real Chromium integration/calibration; no agent/model/API calls.
import { createServer } from 'node:http';
import { mkdir,mkdtemp,readFile,rm,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { startPresentedFrameCapture } from '../dist/observability/presented-frames.js';
import { TestRunner } from '../dist/test-runner.js';
import { PlaywrightDriver } from '../dist/drivers/playwright.js';
import { FilesystemSink } from '../dist/artifacts/filesystem-sink.js';
const out=resolve(process.env.DESIGN_EVIDENCE??'/tmp/browser-presented-frames');await mkdir(out,{recursive:true});
const html=`<!doctype html><style>:root{--fixture-delay:240ms;--fixture-window:700ms;--fixture-positive:rgb(0,255,0)}body{margin:0;background:white}button{position:absolute;left:20px;top:20px}#feedback{position:absolute;left:20px;top:100px;width:40px;height:40px;background:rgb(20,20,20)}canvas{position:absolute;right:0;bottom:0}</style><button id="trigger">Show feedback</button><div id="feedback"></div><canvas width="2" height="2"></canvas><script>let tick=0;const ctx=document.querySelector('canvas').getContext('2d');function paint(){ctx.fillStyle=(tick++%2)?'red':'blue';ctx.fillRect(0,0,2,2);requestAnimationFrame(paint)}paint();document.querySelector('button').addEventListener('click',e=>{if(!e.isTrusted)return;window.fixtureInputEpoch=performance.timeOrigin+e.timeStamp;const control=new URL(location).searchParams.get('control');const update=()=>{document.querySelector('#feedback').style.background=getComputedStyle(document.documentElement).getPropertyValue('--fixture-positive');window.fixtureMutationEpoch=performance.timeOrigin+performance.now()};if(control==='immediate')update();if(control==='delayed')setTimeout(update,parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--fixture-delay')))});</script>`;
const server=createServer((req,res)=>{if(req.url?.startsWith('/forbidden-model')){unexpectedModelRequests++;res.writeHead(500);res.end('Inference forbidden in observation proof');return}res.writeHead(200,{'content-type':'text/html'});res.end(html)});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}`;
const reviewBoundaries=process.argv.includes('--review-boundaries');
const clockAndRunner=reviewBoundaries||process.argv.includes('--clock-and-runner');
const cases=[],boundaryCases=[];let failure,integration;let unexpectedModelRequests=0;
try{
 for(const backend of ['playwright','patchright']){
  const runtime=await import(backend);const packageVersion=JSON.parse(await readFile(`node_modules/${backend}/package.json`,'utf8')).version;
  const browser=await runtime.chromium.launch({headless:true});
  try{
   for(const control of (clockAndRunner?['delayed']:['immediate','delayed','never'])){
    const id=`${backend}-${control}`;const context=await browser.newContext({viewport:{width:480,height:300},deviceScaleFactor:1,recordVideo:{dir:resolve(out,id,'video'),size:{width:480,height:300}}});const page=await context.newPage();let capture;
    try{
     await page.goto(`${url}?control=${control}`);
     const settings=await page.evaluate(()=>{const s=getComputedStyle(document.documentElement);const r=document.querySelector('#feedback').getBoundingClientRect();return {windowMs:parseFloat(s.getPropertyValue('--fixture-window')),delayMs:parseFloat(s.getPropertyValue('--fixture-delay')),roi:{x:r.x,y:r.y,width:r.width,height:r.height},rgba:[...s.getPropertyValue('--fixture-positive').matchAll(/\d+/g)].map(x=>Number(x[0])).concat(255)}});
     const sink=new FilesystemSink(out);
     capture=await startPresentedFrameCapture(page,{input:{selector:'#trigger',event:'click'},feedback:{roi:settings.roi,rgba:settings.rgba,channelTolerance:0,minimumFraction:1},observationWindowMs:settings.windowMs,maxFrames:200,backend:`${backend}@${packageVersion}`},sink,id);
     await page.locator('#trigger').click();await page.waitForTimeout(settings.windowMs*1.5);
     const diagnostics=await page.evaluate(()=>({inputEpoch:window.fixtureInputEpoch,mutationEpoch:window.fixtureMutationEpoch??null}));
     const report=await capture.stop();const attempt=report.attempts[0];
     if(report.status!=='NATIVE_FRAMES_OBSERVED'||report.inputs.length!==1||report.errors.length)throw new Error(`${id}: native/input provenance failed ${JSON.stringify(report.errors)}`);
     if(control==='never'?attempt?.status!=='NO_FEEDBACK_OBSERVED':attempt?.status!=='BRACKETED')throw new Error(`${id}: wrong actual pixel feedback result ${JSON.stringify(attempt)}`);
     cases.push({id,backend,packageVersion,control,settings,diagnostics,report,video:(await page.video().path()).replace(out+'/','')});
     await writeFile(resolve(out,'report.json'),JSON.stringify({source:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),status:'PARTIAL',cases},null,2)+'\n');
    }finally{await capture?.stop();await context.close()}
   }
  }finally{await browser.close()}
 }
 if(!clockAndRunner)for(const backend of ['playwright','patchright']){
  const immediate=cases.find(c=>c.backend===backend&&c.control==='immediate').report.attempts[0];
  const delayed=cases.find(c=>c.backend===backend&&c.control==='delayed').report.attempts[0];
  if(!(delayed.intervalMs[0]>immediate.intervalMs[1]))throw new Error(`${backend}: delayed feedback not distinguished from immediate brackets`);
 }
 if(clockAndRunner){
  // Existing real TestRunner + PlaywrightDriver. Its maintained beforeTurn hook
  // stops before inference; warmup is disabled, provider URL stays loopback.
  process.env.BAD_NO_WARMUP='1';
  const runtime=await import('playwright');const browser=await runtime.chromium.launch({headless:true});
  try{
   const context=await browser.newContext({viewport:{width:480,height:300},deviceScaleFactor:1});
   try{
    const page=await context.newPage();await page.goto(`${url}?control=delayed`);
    const sink=new FilesystemSink(out);const id='test-runner-seam';
    const config={input:{selector:'#trigger',event:'click'},feedback:{roi:{x:20,y:100,width:40,height:40},rgba:[0,255,0,255],channelTolerance:0,minimumFraction:1},observationWindowMs:700,maxFrames:200,backend:'real-TestRunner-PlaywrightDriver'};
    const runner=new TestRunner({driver:new PlaywrightDriver(page),artifactSink:sink,config:{provider:'openai',baseUrl:url+'/forbidden-model',vision:false,observability:{presentedFrames:config}},beforeTurn:async()=>{throw new Error('observation-only proof: stop before model turn')}});
    const result=await runner.runTest({id,name:'Real no-model report integration',startUrl:'',goal:'Observe fixture only; intentional abort before inference',setup:async p=>{await p.locator('#trigger').click();await p.waitForTimeout(config.observationWindowMs*1.5)}});
    const native=JSON.parse(await readFile(resolve(out,id,'presented-frames.json'),'utf8'));
    const log=JSON.parse(await readFile(resolve(out,id,'runtime-log.json'),'utf8'));
    if(result.turnsUsed!==0||result.tokensUsed!==0||result.agentSuccess||!String(result.agentResult.reason).includes('stop before model turn'))throw new Error('No-model stop contract failed');
    if(native.status!=='NATIVE_FRAMES_OBSERVED'||native.attempts[0]?.status!=='BRACKETED'||JSON.stringify(result.presentedFrames)!==JSON.stringify(native)||JSON.stringify(log.presentedFrames)!==JSON.stringify(native))throw new Error('TestResult/runtime-log/native artifact disagree');
    await writeFile(resolve(out,id,'test-result.json'),JSON.stringify(result,null,2)+'\n');
    integration={status:'PASS',mode:'Intentional beforeTurn abort, no model inference or application success claim',turns:result.turnsUsed,tokens:result.tokensUsed,result:`${id}/test-result.json`,runtimeLog:`${id}/runtime-log.json`,frames:native.frames.length};
   }finally{await context.close()}
  }finally{await browser.close()}
 }
 if(reviewBoundaries){
  const runtime=await import('playwright');
  for(const scenario of ['overlap','persistent','page-forgery']){
   const id=`review-${scenario}`;let browser,context,capture,profileDir,result={id,scenario};
   try{
    const options={viewport:{width:480,height:300},deviceScaleFactor:1,recordVideo:{dir:resolve(out,id,'video'),size:{width:480,height:300}}};
    if(scenario==='persistent'){profileDir=await mkdtemp(resolve(tmpdir(),'bad-review-profile-'));context=await runtime.chromium.launchPersistentContext(profileDir,{...options,headless:true})}
    else{browser=await runtime.chromium.launch({headless:true});context=await browser.newContext(options)}
    const page=context.pages()[0]??await context.newPage();await page.goto(`${url}?control=delayed`);
    result.browserOwnerNull=context.browser()===null;
    const config={input:{selector:'#trigger',event:'click'},feedback:{roi:{x:20,y:100,width:40,height:40},rgba:[0,255,0,255],channelTolerance:0,minimumFraction:1},observationWindowMs:700,maxFrames:200,backend:`playwright-real-review-${scenario}`};
    capture=await startPresentedFrameCapture(page,config,new FilesystemSink(out),id);
    if(scenario==='page-forgery'){await page.goto(`${url}?control=delayed`);result.sameOriginNavigation=true}
    if(scenario==='page-forgery')result.attackProbe=await page.evaluate(()=>{
     const names=Reflect.ownKeys(globalThis).filter(x=>typeof x==='string'&&x.startsWith('__bad_presented_'));let invoked=0;
     for(const name of names)if(typeof globalThis[name]==='function'){
      const eventTimestamp=performance.now();globalThis[name](JSON.stringify({epochMs:performance.timeOrigin+eventTimestamp,timeOrigin:performance.timeOrigin,eventTimestamp,trusted:true,event:'click',selector:'#trigger'}));invoked++;
     }
     document.querySelector('#trigger').dispatchEvent(new MouseEvent('click',{bubbles:true}));
     return {visibleGlobals:names.map(String),invoked,syntheticClickDispatched:true};
    });
    await page.locator('#trigger').click();
    if(scenario==='overlap'){await page.waitForTimeout(60);await page.locator('#trigger').click()}
    await page.waitForTimeout(config.observationWindowMs*1.5);
    result.report=await capture.stop();result.video=(await page.video().path()).replace(out+'/','');
    const q=result.report;
    if(q.status!=='NATIVE_FRAMES_OBSERVED'||q.errors.length)throw new Error('Missing native observation: '+JSON.stringify(q.errors));
    if(scenario==='overlap'){
     if(q.inputs.length!==2||q.attempts.length!==2||!q.attempts.every(a=>a.status==='UNKNOWN'&&a.reason?.includes('Overlapping'))||!q.frames.some(f=>f.feedback))throw new Error('Both intersecting windows must reject feedback attribution');
    }else if(q.inputs.length!==1||q.attempts[0]?.status!=='BRACKETED')throw new Error('Expected exactly one genuine trusted-input feedback bracket');
    if(scenario==='page-forgery'&&(result.attackProbe.visibleGlobals.length||result.attackProbe.invoked))throw new Error('Input binding leaked into page main world');
    result.status='PASS';
   }catch(error){result.status='FAIL';result.failure=String(error);if(capture&&!result.report)result.report=await capture.stop()}
   finally{try{await context?.close()}finally{try{await browser?.close()}finally{if(profileDir){await rm(profileDir,{recursive:true});result.profileRemoved=true}}}}
   boundaryCases.push(result);await writeFile(resolve(out,id+'.json'),JSON.stringify(result,null,2)+'\n');
  }
  if(boundaryCases.some(c=>c.status!=='PASS'))throw new Error('Review boundaries failed: '+boundaryCases.filter(c=>c.status!=='PASS').map(c=>c.scenario).join(', '));
 }
}catch(error){failure=String(error)}finally{await new Promise(resolve=>server.close(resolve))}
if(unexpectedModelRequests)failure=`Unexpected model requests: ${unexpectedModelRequests}`;
const result={mode:reviewBoundaries?'review-boundaries-and-TestRunner':clockAndRunner?'clock-provenance-and-TestRunner':'feedback-controls',captureSourceSha256:createHash('sha256').update(await readFile('src/observability/presented-frames.ts')).digest('hex'),captureArtifactSha256:createHash('sha256').update(await readFile('dist/observability/presented-frames.js')).digest('hex'),boundaryCases,integration,unexpectedModelRequests,source:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),at:new Date().toISOString(),node:process.version,status:failure?'FAIL':'PASS',failure,calibration:{nativeTimestampProvenance:'Direct optional CDP metadata.timestamp; absent is UNKNOWN; no hidden publicAPI fallback',controls:'Fixed pixel ROI/color; immediate vs delayed vs never; heartbeat outside ROI forces capture cadence',presentationConformance:'UNCHECKED: exact156 producer is expected-display-reference-or-current-time; exact148 is metadata-build-time. Neither acknowledges actual presentation; no2x40/application latency qualification.'},cases};
await writeFile(resolve(out,'report.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({status:result.status,cases:cases.length,report:resolve(out,'report.json'),failure}));if(failure)process.exitCode=1;
