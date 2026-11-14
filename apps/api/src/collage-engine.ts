import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import sharp,{type OverlayOptions} from 'sharp';
import type {MovieCompositionLayer} from '@memories/shared';
import {ApiError} from './errors.js';

export type CollageLayout='SPLIT_SCREEN'|'EDITORIAL_THREE'|'GRID_FOUR'|'MOSAIC_SIX'|'CONTACT_SHEET_EIGHT'|'FILMSTRIP'|'SCRAPBOOK'|'BEFORE_AFTER'|'ACTION_GRID'|'TRAVEL_BOARD';
export type CollageRect={x:number;y:number;width:number;height:number;zIndex:number};
const inset=.045,gap=.018;
/** Normalized safe-area layouts. Each slot preserves image proportions through contain/cover, never stretch. */
export function collageLayoutRects(layout:CollageLayout,count:number,aspectRatio:'16:9'|'9:16'='16:9',options:{safeMargin?:number;gap?:number}={}):CollageRect[]{
 if(!Number.isInteger(count)||count<2||count>8)throw new ApiError(422,'COLLAGE_PHOTO_COUNT','A collage needs 2–8 photographs. Use additional scenes for a larger moment.');
 const portrait=aspectRatio==='9:16',inset=Math.max(.02,Math.min(.15,options.safeMargin??.045)),gap=Math.max(0,Math.min(.08,options.gap??.018));
 const rect=(x:number,y:number,width:number,height:number,zIndex=1):CollageRect=>({x:inset+x*(1-inset*2),y:inset+y*(1-inset*2),width:width*(1-inset*2),height:height*(1-inset*2),zIndex});
 if(layout==='EDITORIAL_THREE'&&count===3)return portrait?[rect(0,0,1,.48),rect(0,.5,.49,.5),rect(.51,.5,.49,.5)]:[rect(0,0,.55,1),rect(.57,0,.43,.49),rect(.57,.51,.43,.49)];
 if(layout==='SCRAPBOOK'||layout==='TRAVEL_BOARD'){
  if(count<=4)return Array.from({length:count},(_,i)=>{const col=i%2,row=Math.floor(i/2);return rect(.02+col*.43+(row?0.03:0),.02+row*.44,.53,.52,i+1);});
 }
 let columns:number;
 if(layout==='SPLIT_SCREEN'||layout==='BEFORE_AFTER')columns=portrait?1:2;
 else if(layout==='FILMSTRIP')columns=portrait?2:Math.min(4,count);
 else if(layout==='MOSAIC_SIX')columns=portrait?2:3;
 else if(layout==='CONTACT_SHEET_EIGHT')columns=portrait?2:4;
 else columns=portrait?2:Math.ceil(Math.sqrt(count));
 columns=Math.min(count,columns);const rows=Math.ceil(count/columns),w=(1-gap*(columns-1))/columns,h=(1-gap*(rows-1))/rows;
 return Array.from({length:count},(_,i)=>rect((i%columns)*(w+gap),Math.floor(i/columns)*(h+gap),w,h,i+1));
}
export function buildCollageLayers(ids:readonly string[],layout:CollageLayout,durationSeconds:number,aspectRatio:'16:9'|'9:16',options:{staggerSeconds?:number;zoom?:number;fit?:'contain'|'cover';animation?:string;safeMargin?:number;gap?:number}={}):MovieCompositionLayer[]{
 const rects=collageLayoutRects(layout,ids.length,aspectRatio,options),stagger=Math.max(0,Math.min(.5,options.staggerSeconds??.12));
 return ids.map((id,index)=>({id:`photo-${index}`,kind:'photo',sourcePhotoId:id,...rects[index],opacity:1,startSeconds:Math.min(index*stagger,durationSeconds*.15),durationSeconds:durationSeconds-Math.min(index*stagger,durationSeconds*.15),fit:options.fit??'contain',easing:'easeInOut',animation:options.animation==='slide'?'slide':'fade',keyframes:[{time:0,scale:1},{time:durationSeconds,scale:Math.max(1,Math.min(1.08,options.zoom??1.025))}]}));
}
/** Only one bounded thumbnail is decoded at a time; outputs are exact, reproducible original-photo tiles. */
export async function prepareCollageTile(file:string,output:string,width:number,height:number,options:{fit?:'contain'|'cover';rounded?:boolean;shadow?:boolean;background?:string}={}){
 await mkdir(path.dirname(output),{recursive:true,mode:0o700});const pad=options.shadow?Math.max(2,Math.round(Math.min(width,height)*.025)):0,w=Math.max(2,width-pad*2),h=Math.max(2,height-pad*2),radius=options.rounded?Math.round(Math.min(w,h)*.035):0;
 let picture=await sharp(file,{limitInputPixels:100000000,failOn:'error'}).rotate().resize(w,h,{fit:options.fit??'contain',position:options.fit==='cover'?sharp.strategy.attention:'centre',background:options.background??'#202A25'}).ensureAlpha().png().toBuffer();
 if(radius)picture=await sharp(picture).composite([{input:Buffer.from(`<svg width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${radius}" fill="white"/></svg>`),blend:'dest-in'}]).png().toBuffer();
 const layers:OverlayOptions[]=[];
 if(options.shadow){const shadow=await sharp({create:{width,height,channels:4,background:'#00000000'}}).composite([{input:Buffer.from(`<svg width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${radius}" fill="#000000" fill-opacity=".4"/></svg>`),left:pad,top:pad}]).blur(Math.max(1,pad/2)).png().toBuffer();layers.push({input:shadow,left:0,top:0});}
 layers.push({input:picture,left:pad,top:pad});await sharp({create:{width,height,channels:4,background:'#00000000'}}).composite(layers).png().toFile(output);return output;
}
