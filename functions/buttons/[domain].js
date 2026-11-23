import { button } from '../../hub/routes.mjs';
export const onRequestGet = (ctx) => button(ctx);
export const onRequestHead = onRequestGet; // so curl -I sees the same headers
