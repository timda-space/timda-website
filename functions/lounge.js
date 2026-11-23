import { lounge } from '../hub/routes.mjs';
export const onRequestGet = (ctx) => lounge(ctx);
export const onRequestHead = onRequestGet; // so curl -I sees the same headers
