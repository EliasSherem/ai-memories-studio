import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { storyboardContentSchema, type StoryboardContent } from '@memories/shared';
import { simplifyGeminiSchema } from '../src/gemini-schema.js';

type Schema=Record<string,any>;
function content():StoryboardContent {
  return {schemaVersion:'1.0',title:'A grounded film',synopsis:'Original photos and clearly fictional cinematic moments.',targetDurationSeconds:150,scenes:Array.from({length:6},(_,index)=>({id:randomUUID(),sequenceNumber:index+1,type:index<3?'ORIGINAL_ANIMATION':'NEW_CINEMATIC_SCENE',title:index<3?'An original frame':'A fictional scene',description:'A composition grounded in the supplied references.',durationSeconds:25,sourcePhotoIds:[randomUUID()],protagonistIds:['person1','person2'],visualStyle:'Natural light',cameraDirection:'Slow push in',motionPrompt:'Subtle movement',emotionalTone:'Warm',continuityNotes:'Thematic continuity.',generationInstructions:'Use supplied references.',isFictional:index>=3,requiresUserConfirmation:index>=3,userConfirmed:false}))};
}

describe('bounded Gemini storyboard wire schema',()=>{
  it('removes state-expanding constraints while preserving every required scene field and enum',()=>{
    const original=z.toJSONSchema(storyboardContentSchema) as Schema;
    const before=structuredClone(original);
    const wire=simplifyGeminiSchema(original) as Schema;
    const scene=wire.properties.scenes.items;
    expect(wire.required).toEqual(original.required);
    expect(scene.required).toEqual(original.properties.scenes.items.required);
    expect(Object.keys(scene.properties)).toEqual(Object.keys(original.properties.scenes.items.properties));
    expect(scene.properties.type.enum).toEqual(['ORIGINAL_ANIMATION','NEW_CINEMATIC_SCENE','PHOTO_MONTAGE','TITLE_SEQUENCE']);
    expect(scene.properties.protagonistIds.items.enum).toEqual(['person1','person2']);
    expect(wire.additionalProperties).toBe(false);expect(scene.additionalProperties).toBe(false);
    const encoded=JSON.stringify(wire);
    for(const keyword of ['$schema','minItems','maxItems','minimum','maximum','exclusiveMinimum','minLength','maxLength','pattern','format']) expect(encoded).not.toContain(`"${keyword}":`);
    expect(original).toEqual(before);
    scene.required.push('a-test-only-field');
    expect(original).toEqual(before);
  });
  it('preserves property names that look like validation keywords',()=>{
    const wire=simplifyGeminiSchema({type:'object',required:['maximum','format'],properties:{maximum:{type:'integer',maximum:10},format:{type:'string',maxLength:20}},additionalProperties:false}) as Schema;
    expect(wire.properties).toEqual({maximum:{type:'integer'},format:{type:'string'}});
    expect(wire.required).toEqual(['maximum','format']);
  });
  it('keeps strict application validation for duration, array bounds, UUIDs, lengths and extra fields',()=>{
    const original=z.toJSONSchema(storyboardContentSchema) as Schema;
    simplifyGeminiSchema(original);
    expect(storyboardContentSchema.safeParse(content()).success).toBe(true);
    const mutations:((value:StoryboardContent)=>void)[]=[
      value=>{value.targetDurationSeconds=119;},
      value=>{value.scenes=value.scenes.slice(0,5);},
      value=>{value.scenes[0].id='not-a-uuid';},
      value=>{value.scenes[0].sourcePhotoIds=['not-a-uuid'];},
      value=>{value.scenes[0].sourcePhotoIds=Array.from({length:31},()=>randomUUID());},
      value=>{value.scenes[0].durationSeconds=61;},
      value=>{value.scenes[0].description='x'.repeat(3001);},
      value=>{(value.scenes[0] as unknown as Record<string,unknown>).unexpected=true;},
    ];
    for(const mutate of mutations) {const value=content();mutate(value);expect(storyboardContentSchema.safeParse(value).success).toBe(false);}
  });
});
