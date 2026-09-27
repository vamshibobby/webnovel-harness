import assert from 'node:assert/strict';
import { applyBiblePatch, validateBiblePatch } from './lib/bibleValidate.js';
import { canonAt, canonConflicts, deleteCanonChapter, invalidateCanon, sourcePatch } from './lib/canon.js';
import { withModelPolicy, modelRuns, recordModelRun, seedModelRuns, assertRoleBudget, validateModelRoles, rolePolicy } from './lib/modelPolicy.js';
import { streamChat } from './engine/openrouter.js';

const patch = (v: unknown, n: number) => validateBiblePatch(v,n);
let e = applyBiblePatch(null,'lina',patch({type:'character',name:'Lina',status:'alive'},1),1,{origin:'chapter',revision:'one'});
e = applyBiblePatch(e,'lina',patch({status:'dead',newFacts:[{text:'Lina died.'}]},2),2,{origin:'chapter',revision:'two'});
assert.equal(canonAt(e,1).status,'alive');
assert.equal(applyBiblePatch(e,'lina',{status:'injured'},1,{origin:'chapter',revision:'earlier-correction'}).status,'dead','an earlier proposal cannot overwrite a later canonical event');
assert.equal(deleteCanonChapter(e,2).status,'alive');
assert.equal(invalidateCanon(e,2).status,'alive');
assert.equal(canonConflicts(e,{status:'alive'}).length,1);
e = applyBiblePatch(e,'lina',patch({attributes:{voice:'curt'}},2),2,{origin:'author',revision:'manual'});
assert.equal(invalidateCanon(e,2).attributes.voice,'curt');
const {canon: _history,...legacy} = e;
assert.equal(deleteCanonChapter(legacy,2).status,'');
assert.equal(deleteCanonChapter(legacy,2).canon?.needsReview,true);
assert.throws(()=>sourcePatch({evidence:'invented'}, {number:1,content:'Lina kept the key.'}, 'Lina kept the key.'), /exact passage/);
const sourced=sourcePatch(patch({newFacts:[{text:'Has key',evidence:'kept the key'}]},1),{number:1,content:'Lina kept the key.'},'Lina kept the key.');
assert.ok(sourced.newFacts?.[0].revision);
const belief=patch({newKnowledge:[{kind:'believes',fact:'The king lives',via:'Rumor',evidence:'They say he lives.'}]},1);
let kn=applyBiblePatch(null,'tom', {...belief,type:'character',name:'Tom'},1,{origin:'chapter',revision:'a'});
const oldId=kn.knowledge![0].id;
kn=applyBiblePatch(kn,'tom',patch({newKnowledge:[{kind:'knows',fact:'The king died',via:'Witness',evidence:'I saw him die.',supersedes:oldId}]},2),2,{origin:'chapter',revision:'b'});
assert.equal(canonAt(kn,1).knowledge![0].kind,'believes');
assert.equal(kn.knowledge!.length,1);
assert.equal(deleteCanonChapter(kn,2).knowledge![0].id,oldId);
assert.equal(deleteCanonChapter(kn,1).knowledge![0].fact,'The king died');
assert.throws(()=>applyBiblePatch(kn,'tom',patch({newKnowledge:[{kind:'knows',fact:'x',via:'v',evidence:'e',supersedes:'absent'}]},3),3),/existing knowledge/);
assert.throws(()=>validateModelRoles({editor:{budgetUsd:-1}}));
assert.throws(()=>validateModelRoles({unknown:{model:'x/y'}}));
assert.throws(()=>validateModelRoles({writer:{maxOutputTokens:1}}));
await Promise.all([
  withModelPolicy({editor:{model:'x/one'}},async()=>{await Promise.resolve();assert.equal(rolePolicy('editor').model,'x/one');}),
  withModelPolicy({editor:{model:'x/two'}},async()=>{await Promise.resolve();assert.equal(rolePolicy('editor').model,'x/two');}),
]);
const fetchOriginal=globalThis.fetch;
const calls: Array<Record<string,unknown>>=[];
const sse=(frames:unknown[])=>new Response(frames.map(f=>`data: ${JSON.stringify(f)}\n\n`).join('')+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
try {
  globalThis.fetch=async (_url,init)=>{
    const body=JSON.parse(String(init?.body)); calls.push(body);
    if(body.model==='x/bad') return new Response('{"error":{"message":"unsupported"}}',{status:404});
    return sse([{model:body.model,provider:'fixture',choices:[{delta:{content:'Prose'},finish_reason:'stop'}],usage:{cost:0.02,prompt_tokens:10,completion_tokens:3}}]);
  };
  await withModelPolicy({editor:{model:'x/bad',fallbackModels:['x/good'],maxOutputTokens:300,budgetUsd:0.01}},async()=>{
    const result=await streamChat({apiKey:'private-test-key',model:'x/ignored',role:'editor',messages:[{role:'user',content:'private prose'}],maxTokens:1000});
    assert.equal(result.content,'Prose'); assert.deepEqual(calls.map(c=>c.model),['x/bad','x/good']); assert.equal(calls[1].max_tokens,300);
    assert.equal(modelRuns().length,2); assert.equal(modelRuns()[1].cost,0.02);
    assert.ok(!JSON.stringify(modelRuns()).includes('private'));
    assert.throws(()=>assertRoleBudget('editor'),/spending limit/);
    const runs=modelRuns();seedModelRuns(runs);assert.throws(()=>assertRoleBudget('editor'),/spending limit/);
  });
  calls.length=0;
  globalThis.fetch=async(_url,init)=>{calls.push(JSON.parse(String(init?.body)));return sse([{choices:[{delta:{content:'Partial'}}]},{error:{message:'lost stream'}}]);};
  await withModelPolicy({editor:{fallbackModels:['x/fallback']}},async()=>{
    await assert.rejects(streamChat({apiKey:'test',model:'x/primary',role:'editor',messages:[]}),/lost stream/);assert.equal(calls.length,1);
  });
  calls.length=0;
  globalThis.fetch=async(_url,init)=>{calls.push(JSON.parse(String(init?.body)));return new Response('bad key',{status:401});};
  await withModelPolicy({editor:{fallbackModels:['x/fallback']}},async()=>{await assert.rejects(streamChat({apiKey:'test',model:'x/primary',role:'editor',messages:[]}));assert.equal(calls.length,1);});
  globalThis.fetch=async()=>sse([{choices:[{delta:{content:'Prose'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:3}}]);
  await withModelPolicy({editor:{budgetUsd:0.1}},async()=>{
    await streamChat({apiKey:'test',model:'x/primary',role:'editor',messages:[]});
    assert.equal(modelRuns()[0].cost,null);assert.throws(()=>assertRoleBudget('editor'),/did not report its cost/);
  });
} finally { globalThis.fetch=fetchOriginal; }
console.log('Harness: canon replay, evidence, beliefs, policy isolation, budgets, fallback and partial-stream guards passed.');
