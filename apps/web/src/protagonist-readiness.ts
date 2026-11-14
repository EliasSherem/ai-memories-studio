import type {Protagonist} from '@memories/shared';
import {MIN_PROTAGONIST_REFERENCES,MAX_PROTAGONIST_REFERENCES} from '@memories/shared/reference-policy';
/** Prefer server diagnostics, which can check file ownership and local availability. */
export function protagonistReadinessIssues(person:Protagonist):string[]{
 if(person.ready)return [];
 if(person.readinessIssues?.length)return person.readinessIssues;
 const issues:string[]=[];
 if(person.referencePhotoIds.length<MIN_PROTAGONIST_REFERENCES){const missing=MIN_PROTAGONIST_REFERENCES-person.referencePhotoIds.length;issues.push(`Add ${missing} more reference photo${missing===1?'':'s'}.`);}
 if(person.referencePhotoIds.length>MAX_PROTAGONIST_REFERENCES)issues.push(`Choose at most ${MAX_PROTAGONIST_REFERENCES} reference photos.`);
 if(!person.name.trim())issues.push('Add a name.');
 if(!person.likenessPermissionConfirmed)issues.push('Confirm permission to use this person’s likeness.');
 if(!issues.length)issues.push('The saved references need verification. Reload this profile or replace any unavailable reference photo.');
 return issues;
}
