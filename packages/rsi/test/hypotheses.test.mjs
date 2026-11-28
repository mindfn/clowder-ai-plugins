import test from 'node:test';
import assert from 'node:assert/strict';
import { progress } from '../dist/progress.js';
import { collectHypotheses, hypothesisViews, editHypothesis } from '../dist/hypotheses.js';
import { validateTiers } from '../dist/tiers.js';
const tiers = [
 {id:'screen',label:'少卡筛选',requireControl:false,seedPolicy:'fixed',requireCycleVars:false},
 {id:'full',label:'整机确认',requireControl:true,seedPolicy:'fresh',requireCycleVars:true,promoteFrom:'screen',promotion:{verdicts:['keep'],minCycles:1}},
];
const fixture = () => ({ objective:{state:'running',currentVersion:'v1',projectPath:'/isolated'}, prep:[],plan:[],members:[],executor:{state:'passed',commands:{submit:'fixture'}},policy:{tiers,schedule:{mode:'anytime'}},metrics:{version:'E1',items:[]},versions:[{id:'v1',vars:{}},{id:'v2',vars:{},hypothesisId:'h1'}],hypotheses:[{id:'h1',title:'改善吞吐？',source:{kind:'manual',by:'owner'},createdAt:1}],rounds:[],upcoming:{tier:'full',scenario:'mixed',hypothesisIds:['h1'],cycleVars:{cards:8},groups:[{id:'change',label:'Candidate',vars:{},version:'v2'}],seeds:[1]} });
const evidence = (extra={}) => ({n:1,tier:'screen',scenario:'mixed',hypothesisIds:['h1'],state:'done',plan:{tier:'screen',tierRule:{...tiers[0],adoption:false},groups:[{id:'change',version:'v2',vars:{}}],seeds:[1]},metrics:{version:'E1',items:[]},runs:[{group:'change',seed:1,state:'done',evidence:true}],report:{verdict:'keep'},decision:{pick:'same'},...extra});
test('tier promotion requires matching complete lower-tier evidence; blocked env/partial/other hypothesis cannot qualify',()=>{
 const d=fixture(); assert.equal(progress(d,2).canRunCycle,false);
 for(const bad of [{runs:[{group:'change',seed:1,state:'failed',error:{kind:'env'}}]},{hypothesisIds:['other']},{aborted:{reason:'manual'}},{report:{verdict:'rollback'}},{plan:{groups:[{id:'change',version:'v1',vars:{}}],seeds:[1]}},{metrics:{version:'E2',items:[]}},{scenario:'other'}]){
  d.rounds=[evidence(bad)]; assert.ok(progress(d,2).blockers.some(b=>b.code==='tierEvidence'),JSON.stringify(bad));
 }
 d.rounds=[evidence()]; const p=progress(d,2); assert.equal(p.canRunCycle,true,JSON.stringify(p.blockers)); assert.equal(p.plan.groups[0].control,true); assert.deepEqual(p.plan.seeds,[2]);
 d.upcoming.cycleVars=undefined; assert.equal(progress(d,2).awaitingCycleVars,true);
});
test('fixed screen seeds and optional control; legacy behavior unchanged, projection does not backfill old data',()=>{
 const d=fixture();d.upcoming.tier='screen';d.upcoming.skipControl=true;d.rounds=[evidence()];
 const before=structuredClone(d);const p=progress(d,2);assert.equal(p.canRunCycle,true);assert.deepEqual(p.plan.seeds,[1]);assert.equal(p.plan.groups.length,1);assert.deepEqual(d,before);
 delete d.policy.tiers;delete d.upcoming.tier;delete d.upcoming.hypothesisIds;delete d.upcoming.scenario;
 assert.equal(progress(d,2).canRunCycle,true);assert.equal(progress(d,2).plan.groups[0].control,true);
});
test('direction hypotheses deduplicate by provenance; maintenance directions excluded; states derive without mutation',()=>{
 const d=fixture();d.hypotheses=[];const r={n:3,report:{directions:['code','variable','discriminate','execution','metric','goal'].map((kind,i)=>({id:String(i),kind,by:'analyst',title:kind,why:'because'}))}};
 collectHypotheses(d,r,5);collectHypotheses(d,r,6);assert.equal(d.hypotheses.length,3);assert.equal(d.hypotheses[0].createdAt,5);
 const h=d.hypotheses[0];d.rounds=[evidence({hypothesisIds:[h.id],runs:[{state:'failed',error:{kind:'env'}}],report:{verdict:'rollback'}})];assert.equal(hypothesisViews(d)[0].status,'blocked');
 d.rounds=[evidence({hypothesisIds:[h.id],report:{verdict:'rollback'}})];assert.equal(hypothesisViews(d)[0].status,'negative');assert.equal(h.status,undefined);
 const made=editHypothesis(d,{title:'手动假设',budget:{cards:2,minutes:5,cardHours:1/6}},'owner',7);assert.equal(made.ok,true);assert.equal(d.hypotheses.at(-1).source.by,'owner');
 assert.equal(editHypothesis(d,{hypothesisId:made.hypothesisId,archived:true},'manager',8).ok,true);assert.equal(hypothesisViews(d).at(-1).status,'archived');
 assert.ok(editHypothesis(d,{title:'bad',budget:{cards:-1}},'owner',9).error);
});
test('invalid tier graph, missing fields and unsafe confirmations are rejected',()=>{
 assert.equal(validateTiers(tiers),null);
 assert.ok(validateTiers([{...tiers[0],promoteFrom:'full'},tiers[1]]));
 assert.ok(validateTiers([tiers[0],{...tiers[1],seedPolicy:'fixed'}]));
 assert.ok(validateTiers([tiers[0],{...tiers[1],promotion:{verdicts:['insufficient']}}]));
});


test('promotion respects guardrails, variable identity, count and explicit cross-scenario allowance',()=>{
 const d=fixture();d.rounds=[evidence()];d.rounds[0].plan.groups[0].vars={knob:1};
 assert.ok(progress(d,2).blockers.some(b=>b.code==='tierEvidence'));
 d.rounds=[evidence()];d.metrics.items=[{id:'quality',guard:true,threshold:0.9,dir:'up'}];d.rounds[0].metrics=structuredClone(d.metrics);d.rounds[0].runs[0].metrics={quality:0.8};
 assert.ok(progress(d,2).blockers.some(b=>b.code==='tierEvidence'));
 d.rounds[0].runs[0].metrics.quality=0.95;assert.equal(progress(d,2).canRunCycle,true);
 d.policy={...d.policy,tiers:structuredClone(tiers)};d.policy.tiers[1].promotion.minCycles=2;assert.ok(progress(d,2).blockers.some(b=>b.code==='tierEvidence'));
 d.rounds.push({...structuredClone(d.rounds[0]),n:2});assert.equal(progress(d,2).canRunCycle,true);
 d.upcoming.scenario='larger';assert.ok(progress(d,2).blockers.some(b=>b.code==='tierEvidence'));
 d.policy.tiers[1].promotion.sameScenario=false;assert.equal(progress(d,2).canRunCycle,true);
});


test('tightening a source-tier rule cannot reinterpret evidence collected under the previous rule',()=>{
 const d=fixture();d.rounds=[evidence()];assert.equal(progress(d,2).canRunCycle,true);
 d.policy={...d.policy,tiers:structuredClone(tiers)};d.policy.tiers[0].label='Renamed only';assert.equal(progress(d,2).canRunCycle,true);
 d.policy.tiers[0].requireControl=true;assert.ok(progress(d,2).blockers.some(b=>b.code==='tierEvidence'));
});
