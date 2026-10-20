import assert from 'node:assert/strict';
import test from 'node:test';
import {validateManifest} from '../index.js';

const base = {
  pluginId:'test.addressed',version:'0.1.0',contractVersion:'0.1.0',name:'Addressed target',
  features:[{id:'chat',name:'Chat',resources:[],capabilities:['messaging.send']}],
  runtime:{transport:'builtin',entrypoint:'dist/plugin.js'},
};
test('addressed delivery is an explicit optional closed action pointer',()=>{
  assert.equal(validateManifest(base).valid,true);
  assert.equal(validateManifest({...base,addressedDelivery:{method:'deliverMessage'}}).valid,true);
  for(const addressedDelivery of [{},{method:''},{method:'deliverMessage',alias:'dot'},true,null]) {
    assert.equal(validateManifest({...base,addressedDelivery}).valid,false,JSON.stringify(addressedDelivery));
  }
});
