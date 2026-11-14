import {MAX_MOVIE_DURATION_SECONDS,MIN_MOVIE_DURATION_SECONDS} from '@memories/shared';
export {MAX_MOVIE_DURATION_SECONDS,MIN_MOVIE_DURATION_SECONDS};
export const validMovieDuration=(value:number)=>Number.isInteger(value)&&value>=MIN_MOVIE_DURATION_SECONDS&&value<=MAX_MOVIE_DURATION_SECONDS;
export const movieDurationGuidance=`Choose a whole-number duration between ${MIN_MOVIE_DURATION_SECONDS} and ${MAX_MOVIE_DURATION_SECONDS} seconds (${MIN_MOVIE_DURATION_SECONDS/60}–${MAX_MOVIE_DURATION_SECONDS/60} minutes).`;
