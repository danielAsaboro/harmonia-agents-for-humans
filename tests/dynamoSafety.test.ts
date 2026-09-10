import { afterEach, describe, expect, it, vi } from 'vitest';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DynamoRepository, recordKey, UnknownCommitOutcome } from '@/lib/dynamo';
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
describe('native DynamoDB transport safety',()=>{
 it('makes no AWS request without explicit paid permission or loopback endpoint',async()=>{
  vi.stubEnv('AWS_LOCAL_ENDPOINT','');vi.stubEnv('HARMONIA_ALLOW_PAID_AWS','false');vi.stubEnv('DYNAMODB_TABLE','test');
  const transport=vi.spyOn(DynamoDBDocumentClient.prototype,'send');
  await expect(new DynamoRepository().read(recordKey('workspaces/test'))).rejects.toThrow('AWS operations disabled');expect(transport).not.toHaveBeenCalled();
 });
 it('does not replay an uncertain transaction commit',async()=>{
  vi.stubEnv('AWS_LOCAL_ENDPOINT','http://127.0.0.1:8766');vi.stubEnv('DYNAMODB_TABLE','test');
  let commits=0;
  vi.spyOn(DynamoDBDocumentClient.prototype,'send').mockImplementation(async command=>{
   if(command.constructor.name==='TransactWriteCommand'){commits++;throw new Error('connection closed after dispatch');}
   return {};
  });
  await expect(new DynamoRepository().insert(recordKey('workspaces/test'),{name:'test'})).rejects.toBeInstanceOf(UnknownCommitOutcome);
  expect(commits).toBe(1);
 });
});
