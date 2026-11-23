import { banner } from '../../hub/routes.mjs';
export const onRequestGet = (ctx) => banner(ctx);
export const onRequestHead = onRequestGet; // so curl -I sees the same headers
