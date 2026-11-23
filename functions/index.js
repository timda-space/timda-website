import { arrivals } from '../hub/routes.mjs';
export const onRequestGet = (ctx) => arrivals(ctx);
export const onRequestHead = onRequestGet; // so curl -I sees the same headers
