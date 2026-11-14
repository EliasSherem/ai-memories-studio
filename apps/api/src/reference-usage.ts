import type {Protagonist,StoryboardScene} from '@memories/shared';
/** Movie exclusion is separate from an explicit, current likeness-reference grant. */
export function isApprovedSceneReference(scene:Pick<StoryboardScene,'type'|'protagonistIds'>,photoId:string,people:readonly Protagonist[]):boolean{
 return scene.type==='NEW_CINEMATIC_SCENE'&&people.some(person=>person.likenessPermissionConfirmed&&scene.protagonistIds.includes(person.id)&&person.referencePhotoIds.includes(photoId));
}
