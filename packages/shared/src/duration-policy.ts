import {z} from 'zod';
/** Whole-movie duration; provider clips and individual scenes have separate limits. */
export const MIN_MOVIE_DURATION_SECONDS=120;
export const MAX_MOVIE_DURATION_SECONDS=900;
export const DEFAULT_MOVIE_DURATION_SECONDS=150;
export const movieDurationSecondsSchema=z.number().finite().int().min(MIN_MOVIE_DURATION_SECONDS).max(MAX_MOVIE_DURATION_SECONDS);
