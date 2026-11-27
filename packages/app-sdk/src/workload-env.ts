/**
 * The kernel's workload-environment lists (`@aura/core/workload-env`, audit
 * N4): a session host scrubs `SERVER_ONLY_ENV` from every session it starts.
 * One list, published by the kernel; never copy it.
 */
export { SERVER_ONLY_ENV, SESSION_VISIBLE_ENV } from '@aura/core/workload-env';
