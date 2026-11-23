import { envBadge } from '../hub/routes.mjs';
export const onRequest = (ctx) => envBadge(ctx);
