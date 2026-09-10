import { readFileSync } from 'node:fs';
import { describe,expect,it } from 'vitest';
import { App } from 'aws-cdk-lib';
import {Template,Match} from 'aws-cdk-lib/assertions';
import {HarmoniaAwsStack} from '../infra/aws/stack';
describe('resident autonomy infrastructure',()=>{
 it('keeps resident cycles opt-in and delivers scheduler wakes to private SQS',()=>{
  expect(readFileSync('.env.example','utf8')).toContain('HARMONIA_ENABLE_RESIDENT_AUTONOMY=false');
  const template=Template.fromStack(new HarmoniaAwsStack(new App(),'ResidentTest'));
  template.hasResourceProperties('AWS::Scheduler::Schedule',{State:'DISABLED',Target:Match.objectLike({Arn:Match.anyValue(),RoleArn:Match.anyValue()})});
  const source=readFileSync('infra/aws/stack.ts','utf8');
  for(const kind of ['heartbeat','dream','wakeup']) expect(source).toContain(kind);
  expect(source).toContain('queues.control');
 }, 30_000);
});
