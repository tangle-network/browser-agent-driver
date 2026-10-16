// Real Chromium integration/calibration; no agent/model/API calls.
import { createServer } from 'node:http';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { startPresentedFrameCapture } from '../dist/observability/presented-frames.js';
import { FilesystemSink } from '../dist/artifacts/filesystem-sink.js';
const out=resolve(process.env.DESIGN_EVIDENCE??'/tmp/browser-presented-frames');await mkdir(out,{recursive:true});
const html=`<!doctype html><style>:root{--fixture-delay:240ms;--fixture-window:700ms;--fixture-positive:rgb(0,255,0)}body{margin:0;background:white}button{position:absolute;left:20px;top:20px}#feedback{position:absolute;left:20px;top:100px;width:40px;height:40px;background:rgb(20,20,20)}canvas{position:absolute;right:0;bottom:0}</style><button id="trigger">Show feedback</button><div id="feedback"></div><canvas width="2" height="2"></canvas><script>let tick=0;const ctx=document.querySelector('canvas').getContext('2d');function paint(){ctx.fillStyle=(tick++%2)?'red':'blue';ctx.fillRect(0,0,2,2);requestAnimationFrame(paint)}paint();document.querySelector('button').addEventListener('click',e=>{window.fixtureInputEpoch=performance.timeOrigin+e.timeStamp;const control=new URL(location).searchParams.get('control');const update=()=>{document.querySelector('#feedback').style.background=getComputedStyle(document.documentElement).getPropertyValue('--fixture-positive');window.fixtureMutationEpoch=performance.timeOrigin+performance.now()};if(control==='immediate')update();if(control==='delayed')setTimeout(update,parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--fixture-delay')))});</script>`;
const server=createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end(html)});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}`;
const cases=[];let failure;
try{
 for(const backend of ['playwright','patchright']){
  const runtime=await import(backend);const packageVersion=JSON.parse(await readFile(`node_modules/${backend}/package.json`,'utf8')).version;
  const browser=await runtime.chromium.launch({headless:true});
  try{
   for(const control of ['immediate','delayed','never']){
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
 for(const backend of ['playwright','patchright']){
  const immediate=cases.find(c=>c.backend===backend&&c.control==='immediate').report.attempts[0];
  const delayed=cases.find(c=>c.backend===backend&&c.control==='delayed').report.attempts[0];
  if(!(delayed.intervalMs[0]>immediate.intervalMs[1]))throw new Error(`${backend}: delayed feedback not distinguished from immediate brackets`);
 }
}catch(error){failure=String(error)}finally{await new Promise(resolve=>server.close(resolve))}
const result={source:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),at:new Date().toISOString(),node:process.version,status:failure?'FAIL':'PASS',failure,calibration:{nativeTimestampProvenance:'Direct optional CDP metadata.timestamp; absent is UNKNOWN; no hidden publicAPI fallback',controls:'Fixed pixel ROI/color; immediate vs delayed vs never; heartbeat outside ROI forces capture cadence',presentationConformance:'UNCHECKED: fixture discrimination is not2x40/live application qualification, physical display timing or bounded clock quantization'},cases};
await writeFile(resolve(out,'report.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({status:result.status,cases:cases.length,report:resolve(out,'report.json'),failure}));if(failure)process.exitCode=1;
