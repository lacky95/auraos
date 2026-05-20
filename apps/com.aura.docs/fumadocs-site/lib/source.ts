import { loader } from 'fumadocs-core/source';
import { docs } from '@/.source';

// fumadocs-core@15 expects `source.files` to be an array, but
// fumadocs-mdx@11's `toFumadocsSource()` returns `{ files: () => [...] }`.
// Unwrap the function form so the two versions interop cleanly.
const mdxSource = docs.toFumadocsSource();
const files =
  typeof mdxSource.files === 'function' ? mdxSource.files() : mdxSource.files;

export const source = loader({
  baseUrl: '/docs',
  source: { files },
});
