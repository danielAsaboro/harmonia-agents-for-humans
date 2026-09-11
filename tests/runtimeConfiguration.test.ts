import {spawnSync} from 'node:child_process';
import {describe,it,expect} from 'vitest';
function run(settings:Record<string,string>) {
 return spawnSync(process.execPath,['-r','./scripts/runtime-environment.cjs','-e','process.stdout.write(JSON.stringify({image:process.env.IMAGE_MAX_COST_USD,model:process.env.NOVA_REEL_MODEL_ID,paid:process.env.HARMONIA_ALLOW_PAID_AWS,source:process.env.HARMONIA_PROVIDER_SETTINGS_JSON}))'],{encoding:'utf8',env:{...process.env,HARMONIA_ALLOW_PAID_AWS:'false',HARMONIA_PROVIDER_SETTINGS_JSON:JSON.stringify(settings),HARMONIA_INTEGRATION_SECRETS_JSON:'{}'}});
}
describe('runtime configuration authority',()=>{
 it('accepts bounded media pricing without retaining source configuration',()=>{
  const value=run({IMAGE_MAX_COST_USD:'0.25'});
  expect(value.status).toBe(0);expect(JSON.parse(value.stdout)).toEqual({image:'0.25',paid:'false'});
 });
 it('expands an exact model release but never paid authority from provider settings',()=>{
  const value=run({NOVA_REEL_MODEL_ID:'amazon.nova-reel-v1:1'});
  expect(value.status).toBe(0);expect(JSON.parse(value.stdout)).toEqual({model:'amazon.nova-reel-v1:1',paid:'false'});
 });
 it('rejects a provider settings attempt to grant spending authority',()=>{
  const value=run({HARMONIA_ALLOW_PAID_AWS:'true'});
  expect(value.status).not.toBe(0);expect(value.stdout).toBe('');
 });
});
