import { random } from '../hub/routes.mjs';
export const onRequestGet = (ctx) => random(ctx);
export const onRequestHead = onRequestGet; // so curl -I sees the same headers
