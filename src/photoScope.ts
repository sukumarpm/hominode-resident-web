import type { Data } from './models';
export type PhotoScope = 'COMMUNITY' | 'BUILDING' | 'UNIT';
export function matchesPhotoScope(
  data: Data,
  communityId: string,
  scope: PhotoScope,
  resourceId: string,
): boolean {
  return (
    (scope === 'COMMUNITY' || scope === 'BUILDING' || scope === 'UNIT') &&
    !!resourceId &&
    data.contractVersion === 2 &&
    data.ownershipScope === scope &&
    data.communityId === communityId &&
    data.resourceId === resourceId &&
    (scope === 'UNIT'
      ? data.unitId === resourceId && typeof data.buildingId === 'string' && !!data.buildingId
      : data.unitId === undefined) &&
    (scope === 'COMMUNITY'
      ? resourceId === communityId && data.buildingId === undefined
      : scope === 'UNIT' || data.buildingId === resourceId)
  );
}
