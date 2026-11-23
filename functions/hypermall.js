import { hypermall } from '../hub/routes.mjs';
export const onRequestGet = (ctx) => hypermall(ctx);
export const onRequestHead = onRequestGet; // so curl -I sees the same headers
