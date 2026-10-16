import type { FsmSource } from '../types.js';
import { buildertrendNormalizer } from './buildertrend.js';
import type { FsmNormalizer } from './common.js';
import { fieldEdgeNormalizer } from './fieldedge.js';
import { housecallProNormalizer } from './housecallpro.js';
import { jobberNormalizer } from './jobber.js';
import { serviceTitanNormalizer } from './servicetitan.js';

export const NORMALIZERS: Record<FsmSource, FsmNormalizer> = {
  jobber: jobberNormalizer,
  housecallpro: housecallProNormalizer,
  servicetitan: serviceTitanNormalizer,
  fieldedge: fieldEdgeNormalizer,
  buildertrend: buildertrendNormalizer,
};

export * from './common.js';
export { jobberNormalizer, hydrateJobber, JOBBER_HYDRATION_QUERIES, type JobberClientOptions } from './jobber.js';
export { housecallProNormalizer } from './housecallpro.js';
export { serviceTitanNormalizer } from './servicetitan.js';
export { fieldEdgeNormalizer } from './fieldedge.js';
export { buildertrendNormalizer } from './buildertrend.js';
