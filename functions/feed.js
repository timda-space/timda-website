import { feed } from '../hub/routes.mjs';
export const onRequestGet = (ctx) => feed(ctx);
export const onRequestHead = onRequestGet;
