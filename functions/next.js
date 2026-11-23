import { next } from '../hub/routes.mjs';
export const onRequestGet = (ctx) => next(ctx);
export const onRequestHead = onRequestGet; // so curl -I sees the same headers
