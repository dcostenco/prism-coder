import {
  registerFactoryAuthority,
  isFactoryAuthorized,
  claimFactoryLease,
  DEFAULT_FACTORY_LEASE_MS,
  FACTORY_LEASE_RENEW_MS,
  type FactoryAuthorityPipeline,
} from "../storage/configStorage.js";

export { DEFAULT_FACTORY_LEASE_MS, FACTORY_LEASE_RENEW_MS };
export type ExecutionAuthorityPipeline = FactoryAuthorityPipeline;

export async function registerPipelineAuthority(pipeline: ExecutionAuthorityPipeline): Promise<string> {
  return registerFactoryAuthority(pipeline);
}
export async function isPipelineAuthorized(pipeline: ExecutionAuthorityPipeline): Promise<boolean> {
  return isFactoryAuthorized(pipeline);
}
export async function claimPipelineLease(pipeline: ExecutionAuthorityPipeline) {
  return claimFactoryLease(pipeline);
}
