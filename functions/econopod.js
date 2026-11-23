import { econopod, signalTest } from '../hub/routes.mjs';
export const onRequestGet = (ctx) => econopod(ctx);
export const onRequestHead = onRequestGet; // so curl -I sees the same headers
export const onRequestPost = (ctx) => signalTest(ctx);
