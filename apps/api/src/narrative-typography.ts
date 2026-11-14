import sharp from 'sharp';
import type {TextOverlay} from '@memories/shared';
import {ApiError} from './errors.js';
const escape=(s:string)=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\u0000/g,'');
export function narrativeOverlayPlacement(overlay:TextOverlay,hasCenteredTitle=false,backgroundHasSubjects=false):TextOverlay {return overlay.position==='center'&&(hasCenteredTitle||backgroundHasSubjects&&overlay.avoidSubjects)?{...overlay,position:'lower-third'}:overlay;}
export type NarrativeRect={x:number;y:number;width:number;height:number;start:number;end:number};
export function avoidNarrativeOverlap(rect:NarrativeRect,placed:readonly NarrativeRect[],height:number,safeMargin:number):NarrativeRect{
 const result={...rect},gap=Math.max(8,Math.round(height*.015)),margin=Math.round(height*safeMargin);
 const overlapping=(one:NarrativeRect,two:NarrativeRect)=>one.start<two.end&&one.end>two.start&&one.x<two.x+two.width&&one.x+one.width>two.x&&one.y<two.y+two.height&&one.y+one.height>two.y;
 for(let attempt=0;attempt<placed.length+1;attempt++){const conflict=placed.find(old=>overlapping(result,old));if(!conflict)return result;result.y=conflict.y-result.height-gap;if(result.y<margin)throw new ApiError(422,'MOVIE_TEXT_OVERLAP','Concurrent captions cannot fit within the title safe area. Shorten, reposition, or retime the overlapping text before rendering.');}
 throw new ApiError(422,'MOVIE_TEXT_OVERLAP','Overlapping captions need different positions or timings.');
}
/** libvips' Pango/HarfBuzz path supplies actual Unicode shaping and bidi, including Hebrew. */
export async function narrativeTextImage(text:TextOverlay,file:string,fontFile:string,width:number,height:number){
 const margin=Math.round(Math.max(.04,Math.min(.2,text.safeMargin))*Math.min(width,height)),padding=Math.max(8,Math.round(height*.014));
 const availableWidth=Math.max(32,width-margin*2-padding*2),availableHeight=Math.round(height*.27);
 const family=fontFile.includes('Arial Unicode')?'Arial Unicode MS':fontFile.includes('Times New Roman')?'Times New Roman':fontFile.includes('DejaVuSans')?'DejaVu Sans':fontFile.includes('DejaVuSerif')?'DejaVu Serif':'sans';
 try{
  const raw=await sharp({text:{text:`<span foreground="${text.color}"${text.language!=='he'&&(text.type==='OPENING_TITLE'||text.type==='CHAPTER_TITLE')?' letter_spacing="1024"':''}>${escape(text.text)}</span>`,font:`${family} ${Math.max(16,Math.round(text.fontSize*height/1080))}`,fontfile:fontFile,width:availableWidth,align:text.alignment==='center'?'centre':text.alignment,rgba:true,wrap:'word-char',spacing:Math.round(height*.008)}}).resize({width:availableWidth,height:availableHeight,fit:'inside',withoutEnlargement:true}).png().toBuffer();
  const metadata=await sharp(raw).metadata(),w=(metadata.width??availableWidth)+padding*2,h=(metadata.height??availableHeight)+padding*2;
  await sharp({create:{width:w,height:h,channels:4,background:text.background?'#14201bc9':'#00000000'}}).composite([{input:raw,left:padding,top:padding}]).png().toFile(file);
  const x=text.alignment==='left'?margin:text.alignment==='right'?width-margin-w:Math.round((width-w)/2);
  // No face recognition is run. Subject-safe default keeps captions in the lower third rather than over the center.
  const position=text.avoidSubjects&&text.position==='center'&&text.type!=='OPENING_TITLE'&&text.type!=='CHAPTER_TITLE'?'lower-third':text.position;
  const y=position==='top'?margin:position==='center'?Math.round((height-h)/2):position==='lower-third'?Math.max(margin,Math.round(height*.75-h/2)):height-margin-h;
  return {file,width:w,height:h,x:Math.max(margin,Math.min(width-margin-w,x)),y:Math.max(margin,Math.min(height-margin-h,y)),shapingEngine:'Pango/HarfBuzz' as const};
 }catch{throw new ApiError(422,'MOVIE_TEXT_INVALID','A narrative caption could not be shaped with the installed Unicode font. Choose a readable font or shorter caption.');}
}
