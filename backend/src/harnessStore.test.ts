import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import type { Chapter } from './lib/types.js';
const dir=mkdtempSync(join(tmpdir(),'harness-regression-'));
process.env.DATA_DIR=dir;
delete process.env.OPENROUTER_API_KEY;
const store=await import('./lib/store.js');
const {startJob,chapterRevision}=await import('./lib/jobs.js');
const {withModelPolicy}=await import('./lib/modelPolicy.js');
const {revisionOf,entryHash}=await import('./lib/canon.js');
const {applyBiblePatch}=await import('./lib/bibleValidate.js');
const {localUser}=await import('./lib/authMiddleware.js');
const {chapterRoutes}=await import('./routes/chapters.js');
const {readDoc}=await import('./lib/localdb.js');
const app=new Hono();app.use('*',(_c,next)=>withModelPolicy({},next));app.use('*',localUser);app.route('/novels/:novelId/chapters',chapterRoutes);
const fetchOriginal=globalThis.fetch;
const sse=(frames:unknown[])=>new Response(frames.map(f=>`data: ${JSON.stringify(f)}\n\n`).join('')+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
try {
  const novel=await store.createNovel('local',{title:'Test',premise:'Courier',styleNotes:'',style:'webnovel',defaultModel:'x/test'});
  const chapter:Chapter={number:1,title:'One',content:'Lina kept the key.',status:'draft',summary:'',model:'x/test',userPrompt:'A key',revisionNotes:[],createdAt:1,updatedAt:1};
  await store.saveChapter(novel.id,chapter);
  const input={model:'x/test',prompt:'A key'};
  await withModelPolicy({},async()=>{
    const job=await startJob(novel.id,1,'revise',chapter,input,false);
    await assert.rejects(startJob(novel.id,1,'revise',chapter,input,false),/running job/);
    job.token('recover me');await job.finish('paused');
    const resumed=await startJob(novel.id,1,'revise',chapter,input,true);
    resumed.restart();await resumed.finish('failed','provider down');
    assert.equal((await store.listJobs(novel.id))[0].text,'recover me','a failed resume keeps the previous checkpoint');
    const next=await startJob(novel.id,1,'revise',chapter,input,true);next.restart();next.token('new partial');await next.checkpoint(true);
    assert.equal((await store.listJobs(novel.id))[0].text,'new partial');
    await store.transactJob(novel.id,next.job.id,j=>({...j!,status:'cancelled'}));
    await assert.rejects(store.saveGeneratedChapter(novel.id,{...chapter,content:'overwrite'},next.job),/changed/);
    await next.finish('paused');assert.equal((await store.listJobs(novel.id))[0].status,'cancelled');
    const final=await startJob(novel.id,1,'revise',chapter,input,false);
    await store.saveGeneratedChapter(novel.id,{...chapter,content:'New prose'},final.job);
    await final.finish('failed','late network failure');assert.equal((await store.listJobs(novel.id))[0].status,'done');
  });
  await assert.rejects(store.updateChapterChecked(novel.id,1,{content:'old tab'},chapterRevision(chapter)),/changed in another tab/);
  await store.saveChapter(novel.id,{...chapter,status:'accepted'});
  const entry=applyBiblePatch(null,'lina',{type:'character',name:'Lina',status:'alive'},1,{origin:'author',revision:'author'});
  await store.transactBibleEntry(novel.id,'lina',()=>entry);
  const proposal={id:'proposal-1',revision:revisionOf(chapter.content),createdAt:1,state:'pending' as const,changes:[{entryId:'lina',name:'Lina',baseHash:entryHash(entry),patch:{status:'dead'},conflicts:['Status changes']}]};
  await store.saveCanonProposal(novel.id,1,proposal);
  await store.resolveCanonProposal(novel.id,1,proposal.revision,true,proposal.id);
  assert.equal((await store.getBibleEntries(novel.id,['lina']))[0].status,'dead');
  await store.resolveCanonProposal(novel.id,1,proposal.revision,true,proposal.id); // idempotent
  await store.saveCanonProposal(novel.id,1,proposal);
  await assert.rejects(store.resolveCanonProposal(novel.id,1,proposal.revision,true,proposal.id),/Canon changed/);
  assert.equal((await store.getChapter(novel.id,1))?.canonProposal?.state,'pending');
  await store.saveCanonProposal(novel.id,1,{...proposal,changes:[]});
  await store.updateChapter(novel.id,1,{content:'Different'});
  await assert.rejects(store.resolveCanonProposal(novel.id,1,proposal.revision,true,proposal.id),/Chapter changed/);
  // A pending write journal is replayed before any read, simulating process death between documents.
  const target=join(dir,'recovered.json');
  writeFileSync(join(dir,'.pending-writes.json'),JSON.stringify([{file:target,data:{complete:true}}]));
  assert.deepEqual(readDoc(target),{complete:true});assert.ok(!existsSync(join(dir,'.pending-writes.json')));
  // Public route: accepted edits save without a provider key and invalidate dependent memory.
  await store.saveChapter(novel.id,{...chapter,status:'accepted',summary:'old summary'});
  await store.updateNovel(novel.id,{bibleChapter:0});
  const response=await app.request(`/novels/${novel.id}/chapters/1`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:'Lina put the key down.',expectedUpdatedAt:1})});
  assert.equal(response.status,200,await response.clone().text());
  const edited=await store.getChapter(novel.id,1);assert.equal(edited?.content,'Lina put the key down.');assert.equal(edited?.summaryStale,true);
  assert.equal((await store.getNovel('local',novel.id))?.bibleChapter,0,'retcon must not advance the extraction watermark');
  assert.equal((await store.getBibleEntries(novel.id,['lina']))[0].status,'alive','author state survives retcon');
  const stale=await app.request(`/novels/${novel.id}/chapters/1`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:'Stale browser',expectedUpdatedAt:1})});assert.equal(stale.status,409);
  // Real extraction route, mocked provider. Evidence is reviewed before canonical writes.
  globalThis.fetch=async(_url,init)=>{
    const b=JSON.parse(String(init?.body));
    if(b.messages.some((m:{role:string})=>m.role==='tool')) return sse([{choices:[{delta:{content:'Done'},finish_reason:'stop'}]}]);
    return sse([{choices:[{delta:{tool_calls:[{index:0,id:'c1',function:{name:'upsert_story_bible_entry',arguments:JSON.stringify({id:'lina',status:'unarmed',evidence:'Lina put the key down.'})}}]},finish_reason:'tool_calls'}]}]);
  };
  const preview=await app.request(`/novels/${novel.id}/chapters/1/canon/preview`,{method:'POST',headers:{'X-OpenRouter-Key':'fixture'},body:'{}'});
  assert.equal(preview.status,200,await preview.clone().text());assert.equal((await store.getBibleEntries(novel.id,['lina']))[0].status,'alive');
  const pending=(await store.getChapter(novel.id,1))!.canonProposal!;
  const reviewed=await app.request(`/novels/${novel.id}/chapters/1/canon/review`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:pending.revision,accept:true,proposalId:pending.id})});
  assert.equal(reviewed.status,200,await reviewed.clone().text());assert.equal((await store.getBibleEntries(novel.id,['lina']))[0].status,'unarmed');
  // Bad evidence must fail the whole extraction, even if the model says it completed.
  globalThis.fetch=async(_url,init)=>{
    const b=JSON.parse(String(init?.body));
    if(b.messages.some((m:{role:string})=>m.role==='tool')) return sse([{choices:[{delta:{content:'Done'},finish_reason:'stop'}]}]);
    return sse([{choices:[{delta:{tool_calls:[{index:0,id:'bad',function:{name:'upsert_story_bible_entry',arguments:JSON.stringify({id:'lina',status:'dead',evidence:'fabricated quote'})}}]},finish_reason:'tool_calls'}]}]);
  };
  const bad=await app.request(`/novels/${novel.id}/chapters/1/canon/preview`,{method:'POST',headers:{'X-OpenRouter-Key':'fixture'},body:'{}'});assert.equal(bad.status,409);assert.equal((await store.getBibleEntries(novel.id,['lina']))[0].status,'unarmed');
  await store.updateNovel(novel.id,{bibleMode:'off',mapMode:'off',suggestMode:'off',chapterCount:1,modelRoles:{writer:{model:'x/writer'},summarizer:{model:'x/summary'}}});
  const calls:string[]=[];
  globalThis.fetch=async(_url,init)=>{
    const b=JSON.parse(String(init?.body));calls.push(b.model);
    const prose=b.model==='x/summary'?'Lina crosses the bridge.':'Chapter 2: The Bridge\n\nLina crossed the bridge. The key pressed against her palm, and she waited for Tomas beneath the clock.';
    return sse([{model:b.model,provider:'fixture',choices:[{delta:{content:prose},finish_reason:'stop'}],usage:{cost:0.001,prompt_tokens:100,completion_tokens:30}}]);
  };
  const generate=await app.request(`/novels/${novel.id}/chapters/2/generate`,{method:'POST',headers:{'Content-Type':'application/json','X-OpenRouter-Key':'fixture'},body:JSON.stringify({prompt:'Cross the bridge'})});
  const generated=await generate.text();assert.ok(generated.includes('event: done'),generated);
  assert.equal((await store.getChapter(novel.id,2))?.modelRuns?.[0].model,'x/writer');
  assert.equal((await store.listJobs(novel.id)).find(j=>j.id==='draft-2')?.status,'done');
  const acceptRequest=()=>app.request(`/novels/${novel.id}/chapters/2/accept`,{method:'POST',headers:{'Content-Type':'application/json','X-OpenRouter-Key':'fixture'},body:'{}'});
  const acceptance=await (await acceptRequest()).text();assert.ok(acceptance.includes('event: accepted')&&acceptance.includes('event: done'),acceptance);
  assert.equal((await store.getChapter(novel.id,2))?.summary,'Lina crosses the bridge.');
  assert.deepEqual(calls,['x/writer','x/summary']);
  await (await acceptRequest()).text();assert.equal(calls.length,2,'repeated acceptance must not run paid upkeep twice');
  assert.equal((await store.listJobs(novel.id)).find(j=>j.id==='upkeep-2')?.stages?.summary,'done');
  // Changing an earlier chapter invalidates later proposals, even when their text is unchanged.
  const ch2=(await store.getChapter(novel.id,2))!;
  await store.saveCanonProposal(novel.id,2,{...proposal,id:'later',revision:revisionOf(ch2.content),state:'applied',changes:[]});
  await store.invalidateBibleFrom(novel.id,1);
  assert.equal((await store.getChapter(novel.id,2))?.canonProposal?.state,'stale');
  await assert.rejects(store.resolveCanonProposal(novel.id,1,proposal.revision,true,'unseen-proposal'),/Chapter changed/);
  console.log('Harness storage/routes: recovery, cancellation, concurrent edits, journal recovery, no-key retcons, canon preview/review and invalid evidence passed.');
} finally {globalThis.fetch=fetchOriginal;rmSync(dir,{recursive:true,force:true});}
