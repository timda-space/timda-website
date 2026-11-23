import { mailRequest } from '../../hub/routes.mjs';
export const onRequestPost = (ctx) => mailRequest(ctx);
