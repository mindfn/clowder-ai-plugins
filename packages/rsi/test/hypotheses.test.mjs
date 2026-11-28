import test from 'node:test';
import assert from 'node:assert/strict';
import { progress } from '../dist/progress.js';
import { collectHypotheses, hypothesisViews, editHypothesis } from '../dist/hypotheses.js';
import { act } from '../dist/actions.js';
import { validateTiers } from '../dist/tiers.js';
const tiers = [
 {id:'screen',label:'少卡筛选',requireControl:false,seedPolicy:'fixed',requireCycleVars:false,resourceVars:['cards','lease']},
 {id:'full',label:'整机确认',requireControl:true,seedPolicy:'fresh',requireCycleVars:true,resourceVars:['cards','lease'],promoteFrom:'screen',promotion:{verdicts:['keep'],minCycles:1}},
];
const fixture = () => ({ objective:{state:'running',currentVersion:'v1',projectPath:'/isolated'}, prep:[],plan:[],members:[],executor:{state:'passed',commands:{submit:'fixture'}},policy:{tiers,schedule:{mode:'anytime'}},metrics:{version:'E1',items:[]},versions:[{id:'v1',config:{},vars:{}},{id:'v2',config:{},vars:{},hypothesisId:'h1'}],hypotheses:[{id:'h1',title:'改善吞吐？',source:{kind:'manual',by:'owner'},createdAt:1}],rounds:[],upcoming:{tier:'full',scenario:'mixed',hypothesisIds:['h1'],cycleVars:{cards:8},groups:[{id:'change',label:'Candidate',vars:{},version:'v2'}],seeds:[1]} });
const evidence = (extra={}) => ({n:1,tier:'screen',scenario:'mixed',hypothesisIds:['h1'],state:'done',plan:{tier:'screen',tierRule:{...tiers[0],adoption:false},groups:[{id:'change',version:'v2',vars:{}}],seeds:[1]},metrics:{version:'E1',items:[]},runs:[{group:'change',seed:1,state:'done',evidence:true,parameters:{config:{},commit:null,base:{},effective:{}}}],report:{verdict:'keep'},decision:{pick:'same'},...extra});
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
 const d=fixture();d.rounds=[evidence()];d.rounds[0].plan.groups[0].vars={knob:1};d.rounds[0].runs[0].parameters.effective={knob:1};
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


const blocked = d => assert.ok(progress(d,2).blockers.some(b=>b.code==='tierEvidence'));
const setCycleVars = (r, vars) => { r.plan.cycleVars=vars; for(const run of r.runs) run.parameters.effective={...vars}; };
const adoption = d => {
 const r=d.rounds[0];r.tier='full';r.plan.tier='full';r.plan.tierRule={...d.policy.tiers[1],adoption:true};
 d.objective.id='obj';d.candidate={id:'change',version:'v2',vars:{},cycle:1};
 const state={experiments:{obj:d},objectives:{cartpole:[d.objective]},library:{},messages:[],outbox:[]};
 const result=act(state,{op:'promote',objective:'obj',version:'v2'},{},3);
 assert.equal(result.status,409,JSON.stringify(result));assert.match(result.error,/highest-tier/);
 assert.notEqual(d.versions[1].status,'confirmed');
};
test('tier evidence never borrows control evidence or a different winning candidate, including explicit adoption',()=>{
 const d=fixture();const r=evidence();
 r.plan.groups=[{id:'control',control:true,version:'v2',vars:{}},{id:'winner',version:'v3',vars:{}}];
 r.runs=['control','winner'].map(group=>({...structuredClone(r.runs[0]),group}));
 r.report.compare={groups:[{group:'control',eligible:true,beatsControl:false},{group:'winner',eligible:true,beatsControl:true}]};
 d.rounds=[r];blocked(d);adoption(structuredClone(d));
 // v2 is a candidate, but only v3 met the criterion in this multi-candidate cycle.
 r.plan.groups[0]={id:'change',version:'v2',vars:{}};r.runs[0].group='change';
 r.report.compare.groups[0].group='change';
 r.plan.groups.push({id:'control',control:true,version:'v1',vars:{}});
 r.runs.push({...structuredClone(r.runs[0]),group:'control'});
 blocked(d);adoption(structuredClone(d));
 r.report.compare.groups[0].beatsControl=true;assert.equal(progress(d,2).canRunCycle,true);
 // With no control, a whole-cycle keep cannot identify which of several candidates passed.
 r.plan.groups.pop();r.runs.pop();blocked(d);
});
test('tier evidence compares effective frozen parameters, allowing only declared resource changes',()=>{
 const d=fixture();d.rounds=[evidence()];setCycleVars(d.rounds[0],{workload:'smoke',lease:'old',cards:1});
 d.upcoming.cycleVars={workload:'production',lease:'new',cards:8};blocked(d);
 d.upcoming.cycleVars.workload='smoke';assert.equal(progress(d,2).canRunCycle,true);
 // A later edit to version defaults must not reinterpret the historical execution.
 d.versions[1].vars={knob:2};blocked(d);delete d.versions[1].vars.knob;
 d.rounds[0].runs[0].parameters.effective.workload='production';blocked(d);
 delete d.rounds[0].runs[0].parameters;blocked(d);
});
test('declared slice guardrails block exceeded or missing measurements, including explicit adoption',()=>{
 const d=fixture();const r=evidence();d.rounds=[r];
 r.plan.groups.push({id:'control',control:true,version:'v1',vars:{}});
 r.runs.push({...structuredClone(r.runs[0]),group:'control'});
 r.report.compare={groups:[{group:'change',eligible:true,beatsControl:true}]};
 d.metrics.slices=[{id:'load',name:'Load',axis:'requests',stats:[{id:'p99',name:'P99',dir:'down',threshold:80}]}];r.metrics=structuredClone(d.metrics);
 for(const slices of [undefined,{}, {load:[]}, {load:[{at:1,values:{}}]}, {load:[{at:1,values:{p99:160}}]}]){
  for(const run of r.runs) run.slices=slices;blocked(d);adoption(structuredClone(d));
 }
 for(const run of r.runs) run.slices={load:[{at:1,values:{p99:70}}]};assert.equal(progress(d,2).canRunCycle,true);
 r.plan.seeds.push(2);r.runs.push(...r.runs.map(run=>({...structuredClone(run),seed:2,slices:{load:[{at:2,values:{p99:70}}]}})));blocked(d);
});


test('effective parameters include inherited defaults and pinned file bases; resource declarations are frozen',()=>{
 const d=fixture();d.rounds=[evidence()];const r=d.rounds[0],v=d.versions[1],snapshot=r.runs[0].parameters;
 v.config={knob:1};snapshot.config={knob:1};snapshot.base={knob:1};snapshot.effective={knob:1};assert.equal(progress(d,2).canRunCycle,true);
 v.vars={knob:2};blocked(d);d.upcoming.groups[0].vars={knob:1};assert.equal(progress(d,2).canRunCycle,true);
 v.config='config.json';snapshot.config='config.json';blocked(d);
 v.commit='pinned';snapshot.commit='pinned';assert.equal(progress(d,2).canRunCycle,true);
 v.commit='changed';blocked(d);v.commit='pinned';
 d.policy={...d.policy,tiers:structuredClone(tiers)};d.policy.tiers[0].resourceVars.push('workload');blocked(d);
 assert.ok(validateTiers([{...tiers[0],resourceVars:['seed']},tiers[1]]));
 assert.ok(validateTiers([{...tiers[0],resourceVars:['lease','lease']},tiers[1]]));
});
