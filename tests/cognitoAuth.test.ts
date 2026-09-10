import { describe, it, expect, vi, afterEach } from "vitest";
import { cognitoSettings } from "@/lib/cognito";
import * as session from "../src/app/api/auth/session/route";
afterEach(()=>vi.unstubAllEnvs());
describe('Cognito session boundary',()=>{
 it('exposes no identity-token or development-bypass login endpoint',()=>{
  expect('POST' in session).toBe(false);expect('GET' in session).toBe(false);
 });
 it('fails closed when identity provider configuration is absent',()=>{
  vi.stubEnv('COGNITO_USER_POOL_ID','');expect(()=>cognitoSettings()).toThrow('Cognito is not configured');
 });
 it('rejects cross-origin session revocation before data access',async()=>{
  const response=await session.DELETE(new Request('https://example.test/api/auth/session',{method:'DELETE',headers:{origin:'https://evil.test'}}));expect(response.status).toBe(403);
 });
});
