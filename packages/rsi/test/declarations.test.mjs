import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {parse} from 'yaml';
const load=(file)=>parse(readFileSync(new URL(`../${file}`,import.meta.url),'utf8'));

test('phase 2 declarations expose native MCP single source of truth, a v2 subscription and matching release versions',()=>{
  const manifest=load('plugin.yaml');
  assert.equal(manifest.contributions.filter((c)=>c.type==='tool').length,0);
  const mcp=manifest.contributions.find((c)=>c.type==='mcp');
  assert.equal(mcp?.id,'rsi-native');
  assert.ok(manifest.features[0].contributions.some((c)=>c.type==='mcp'&&c.id==='rsi-native'));
  const schedule=manifest.contributions.find((c)=>c.type==='schedule');
  assert.deepEqual(schedule.schedule,{kind:'interval',everyMs:180000});assert.equal(schedule.action.method,'rsi.tick');assert.equal(schedule.policy.overlap,'skip');
  assert.ok(manifest.features[0].contributions.some((c)=>c.type==='schedule'&&c.id===schedule.id));
  assert.equal(manifest.contributions.find((c)=>c.type==='message-subscription').presentation,'v2');
  for(const file of ['package.json','npm-shrinkwrap.json'])assert.equal(JSON.parse(readFileSync(new URL(`../${file}`,import.meta.url),'utf8')).version,manifest.version);
});

test('all new-objective openers bind currentThread and selected panel project; writes post them cleanly',()=>{
  const pdl=load('console/pdl.yaml');
  assert.deepEqual(Object.keys(pdl.components).sort(),['css','js']);
  const walk=(value,visit)=>{if(!value||typeof value!=='object')return;visit(value);for(const child of Object.values(value))walk(child,visit);};
  let openers=0;
  for(const view of Object.values(pdl.views))walk(view,(node)=>{
    if(node.kind!=='rsiNewExp')return;
    openers++;assert.equal(node.thread,'$.currentThread.id');assert.equal(node.project,'$.home.projectId');
    assert.equal(view.sources.currentThread,'host:currentThread');
  });
  assert.ok(openers>=4);
  const dialog=pdl.views['dlg.rsiNewExp'];
  assert.equal(dialog.fields.find((f)=>f.arg==='project'),undefined);
  assert.equal(dialog.okArgs.project,'$.project');
  assert.equal(dialog.fields.find((f)=>f.arg==='threadMode').value,'current');
  assert.deepEqual(dialog.fields.find((f)=>f.arg==='threadMode').options.map((o)=>o.v),['current','new']);
  assert.equal(dialog.okArgs.thread,'$.thread');
  assert.equal(dialog.fields.find((f)=>f.arg==='prepare').value,'codex');
  assert.equal(dialog.fields.find((f)=>f.arg==='evaluate').value,'cat-b5ddoo9l');
  assert.equal(pdl.requests.new.body.project,'@project');assert.equal(pdl.requests.new.body.thread,'@thread');assert.equal(pdl.requests.new.body.threadMode,'@threadMode');
  assert.equal(pdl.requests.runCycle.body.op,'runCycle');assert.equal(pdl.requests.refresh.body.op,'refresh');
});

test('all thread navigation buttons use host act: thread with id, never legacy act: open kind: msg',()=>{
  const pdl=load('console/pdl.yaml');
  const walk=(value,visit)=>{if(!value||typeof value!=='object')return;visit(value);for(const child of Object.values(value))walk(child,visit);};
  let threadButtons=0,expThreadFound=false;
  for(const view of Object.values(pdl.views))walk(view,(node)=>{
    assert.notEqual(node.act==='open'&&node.args?.kind==='msg',true,`legacy open/msg action found: ${JSON.stringify(node)}`);
    if(node.act==='thread'){
      threadButtons++;
      assert.ok(node.args&&typeof node.args.id==='string'&&node.args.id.length>0,`thread action missing id: ${JSON.stringify(node)}`);
      if(node.label==='t:rsi.exp.thread'){expThreadFound=true;assert.equal(node.args.id,'$.exp.thread');assert.equal(node.when,'$.exp.thread');}
    }
  });
  assert.equal(expThreadFound,true);
  assert.equal(threadButtons,10);
});

test('i18n yaml packs parse cleanly and rsi.exp dual-tab removes trailing lineage tail clutter',()=>{
  const zh=load('console/i18n/zh.yaml');
  const en=load('console/i18n/en.yaml');
  assert.equal(zh.exp.sec.manage,'分析与管理');
  assert.equal(zh.exp.sec.execute,'治理与执行');
  assert.equal(en.exp.sec.manage,'Analysis & Management');
  assert.equal(en.exp.sec.execute,'Governance & Execution');
  const pdl=load('console/pdl.yaml');
  const walk=(value,visit)=>{if(!value||typeof value!=='object')return;visit(value);for(const child of Object.values(value))walk(child,visit);};
  let expLineages=0;
  walk(pdl.views['rsi.exp'],(node)=>{
    if(node.use==='plugin:official.rsi/rsiLineage'&&node.props?.from==='$.exp.versions'){
      expLineages++;
      assert.equal(node.props.tail,undefined,'rsi.exp version lineage should not render redundant trailing conclusion text');
    }
  });
  assert.equal(expLineages,1);
  // Every plugSet key used in rsi.exp or lineage.js (except _r refresh) must be forwarded in requests.exp.query
  const expQuery=pdl.requests.exp.query;
  const usedKeys=new Set();
  walk(pdl.views['rsi.exp'],(node)=>{
    if((node.act==='plugSet'||node.change==='plugSet')&&typeof node.args?.k==='string'&&node.args.k!=='_r')usedKeys.add(node.args.k);
    if(node.args?.also&&typeof node.args.also==='object')for(const k of Object.keys(node.args.also))usedKeys.add(k);
  });
  const js=readFileSync(new URL('../console/components/lineage.js',import.meta.url),'utf8');
  for(const m of js.matchAll(/data-act="plugSet"[^>]*data-k="([^"]+)"/g))usedKeys.add(m[1]);
  for(const k of usedKeys)assert.equal(expQuery[k],`state.${k}`,`requests.exp.query missing plugSet key: ${k}`);
  // Fullscreen map preview must use Host native viewport dialog (dlg.rsiMap), never plugin-injected body modal; narrow panel defaults to trend line and opens dlg.rsiMap directly
  const mapDlg=pdl.views['dlg.rsiMap'];
  assert.equal(mapDlg?.layout,'viewport');
  assert.equal(mapDlg?.span,'full');
  assert.equal(mapDlg?.sources?.exp,'exp');
  let opensMapDlg=false,inlineOverviewMaps=0,inlineTrends=0;
  walk(pdl.views['rsi.exp'],(node)=>{
    if(node.act==='dialog'&&node.args?.kind==='rsiMap')opensMapDlg=true;
    if(node.use==='plugin:official.rsi/rsiOverviewMap')inlineOverviewMaps++;
    if(node.use==='plugin:official.rsi/rsiTrend')inlineTrends++;
  });
  assert.equal(opensMapDlg,true);
  assert.equal(inlineOverviewMaps,0,'narrow rsi.exp panel should render rsiTrend directly and open dlg.rsiMap on click');
  assert.equal(inlineTrends,1);
  assert.doesNotMatch(js,/rsi-map-modal|addEventListener\(['"]keydown['"]/);
  assert.doesNotMatch(js,/class="scroll-x rsi-map-scroll"/,'overview map scroll must not attach Host .scroll-x which locks overflow-y');
  // alpha.117: reusable bare subviews deduplicate discussion members and objective traces; orphaned dlg.rsiExpPrep removed
  const discussView=pdl.views['rsi.discussMembers'];
  assert.equal(discussView?.bare,true);
  assert.equal(discussView?.sources?.exp,'exp');
  assert.equal(discussView?.sources?.members,'host:members');
  assert.equal(pdl.views['rsi.objectiveTraces']?.bare,true);
  assert.equal(pdl.views['rsi.cardBody'],undefined,'cardBody stays inline until design library supports plugin-root $.pending inside data-bound subviews');
  assert.equal(pdl.views['dlg.rsiExpPrep'],undefined,'orphaned dlg.rsiExpPrep duplicate must stay removed');
  let discussRefs=0,tracesRefs=0,multiSelects=0;
  for(const [viewId,view] of Object.entries(pdl.views))walk(view,(node)=>{
    if(node.type==='view'&&node.id==='rsi.discussMembers')discussRefs++;
    if(node.type==='view'&&node.id==='rsi.objectiveTraces')tracesRefs++;
    if(node.type==='select'&&node.multi===true)multiSelects++;
    // Static gate: data-bound subviews (pdlViewOf without plugin root) must never reference $.pending or $.state
    if(node.type==='view'&&'data' in node&&typeof node.id==='string'){
      const target=pdl.views[node.id];
      assert.ok(target,`data-bound view block in ${viewId} references unknown subview ${node.id}`);
      const checkRootRefs=(val,p)=>{
        if(typeof val==='string')assert.doesNotMatch(val,/(^|!)\$\.(pending|state)(\.|$)/,`data-bound subview ${node.id} (embedded from ${viewId}) references plugin root ${val} at ${p}, which resolves to undefined under pdlViewOf`);
        else if(val&&typeof val==='object')for(const [k,v] of Object.entries(val))checkRootRefs(v,`${p}.${k}`);
      };
      checkRootRefs(target.blocks,`${node.id}.blocks`);
    }
  });
  assert.equal(discussRefs,2,'both active discussion member UI surfaces must reuse rsi.discussMembers');
  assert.equal(tracesRefs,2,'both trace panels in rsi.objective must share rsi.objectiveTraces');
  assert.equal(multiSelects,0,'no V2-degraded multi:true select controls should remain');
  // Every expandable list must declare both `id` (required by Host rows.js `canOpen = ... && o.list`) and `row.key`
  let expandableLists=0;
  for(const [viewId,view] of Object.entries(pdl.views))walk(view,(node)=>{
    if(node.type!=='list')return;
    const rowObj=typeof node.row==='string'?pdl.rows?.[node.row]:node.row;
    const hasExpand=node.expand!=null||(rowObj&&rowObj.expand!=null);
    if(!hasExpand)return;
    expandableLists++;
    assert.ok(typeof node.id==='string'&&node.id.length>0,`expandable list in ${viewId} (from=${node.from}) missing id — Host lrow will disable click-to-expand`);
    assert.ok(typeof rowObj?.key==='string'&&rowObj.key.length>0,`expandable list ${node.id} in ${viewId} missing row.key`);
  });
  assert.ok(expandableLists>=9,`expected >=9 expandable lists audited, got ${expandableLists}`);
  assert.equal(zh.applyResult.concluded,'运行失败·已有结论');
  assert.equal(en.applyResult.concluded,'Run failed · concluded');
});
