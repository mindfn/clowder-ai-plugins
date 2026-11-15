import fs from 'node:fs';
import vm from 'node:vm';
const root = process.argv[2];
if (!root) throw new Error('Usage: node record-prototype.mjs <prototype/rsi directory>');
const NOW = 1800000000000;
const sandbox = {
  MOCK_NOW: NOW, MOCK_ROUTES: {}, MOCK_API: {emit(){}}, FX: {cats:[],threads:[]}, FX_MSGS: {},
  S:{}, VM:{}, A:{}, ENT:{}, PANELS:{}, CHANGES:{}, SET_AFTER:{},
  onStart(_phase, fn){fn()}, threadView(){return 'thread'},
  tc(t,...args){return {t,args}},
  api:{on(){}, get(route, p = {}) { if(route==='/api/cats') return {cats:[]}; return sandbox.MOCK_ROUTES[route](p); }},
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(`${root}/mock.js`, 'utf8'), sandbox);
vm.runInContext(fs.readFileSync(`${root}/app.js`, 'utf8'), sandbox);
const cases=[];
function take(view, query, dialog) {
  Object.assign(sandbox.S,{rsiProject:query.project || 'cartpole',rsiPick:query.pick || 'obj:cp-converge',rsiTab:query.tab || 'version',rsiSelO:query.selO||'',rsiSelE:query.selE||'',rsiSelC:query.selC||'',rsiPanelList:false,panelWide:false,dialog});
  const result=sandbox.VM['rsi'+view[0].toUpperCase()+view.slice(1)]();
  cases.push({view,query,result:result ?? null});
}
for(const view of ['home','todo','caps','library','newExp']) take(view,{project:'cartpole'});
for(const view of ['home','objective','exp','todo','caps','cards','library','policy']) take(view,{project:'pd-infer'});
take('doc',{project:'pd-infer',doc:'doc-pd-overview'},{kind:'rsiDoc',args:{id:'doc-pd-overview'}});
for (const query of [{},{selO:'tool-access-correct-use/v4>c1.gov'},{tab:'metrics',selE:'E1>c1.eval'}]) take('objective',{project:'self',pick:'obj:tool-access-correct-use',...query});
vm.runInContext(`
Object.assign(RSI_CP, {rounds: RSI_CP_SCRIPT.rounds, versions: RSI_CP_SCRIPT.versions, prep: RSI_CP_PREP, steps: undefined, exec: undefined});
delete RSI_CP.night;
RSI_CP.executor.state = 'passed';
Object.assign(RSI_CP.objective, {state:'pending',round:5,currentVersion:'v2',budget:{rounds:20,used:5},goal:RSI_CP_GOAL});
FX_RSI.objectives.cartpole.push(Object.assign({}, RSI_CP_SUMMARY, {state:'pending', running:{o:'v2'}}));
`, sandbox);
for(const query of [{},{selO:'cp-converge/v3>c1.collect'},{selO:'cp-converge/v3>c1.eval'}]) {
  take('exp',{project:'cartpole',...query}); cases.at(-1).script=true;
}
fs.mkdirSync(new URL('./fixtures/', import.meta.url), {recursive:true});
const paths = {
 home:['projects','projectId','nodes','pick','hasObjectives','panelList','navs'],
 caps:['analysis','modify','collect','env'], todo:['items'], cards:['cards'], library:['analysis','docs','groups'],
 newExp:['cats'], policy:['overrides','policy'], doc:['id','kind','title','body','objectiveNames','usedBy'],
 objective:['id','name','state','setup','nowLine','step','ver.id','cycle.n','cycle.decision','eStep','eSel.id','eEval.kind','eLooked','cStep','cSel.id','overrides'],
 exp:['id','state','next.k','next.hint','next.v','next.n','next.count','next.go','now','setup','trend','hitRate','versions','ver.id','step','cycle.n','cycle.waiting','cycle.groups','cycle.notAssessed','prep.needYou','prep.steps.0.state','prep.steps.2.state','prep.steps.3.deps','executor.state','metrics.version'],
};
const references = cases.map(({result,...item}) => ({...item, fields: Object.fromEntries(paths[item.view].map(path => [path, path.split('.').reduce((value,key) => value?.[key],result)]).filter(([,value]) => value !== undefined))}));
fs.writeFileSync(new URL('./fixtures/prototype-views.json', import.meta.url),JSON.stringify({now:NOW,cases:references},null,2)+'\n');
process.stdout.write(`Captured ${cases.length} original VM responses\n`);
