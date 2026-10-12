import { buildProgram } from './program.js';

buildProgram().parseAsync(process.argv).catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
