import { VERSION, buildProgram, isVersionRequest } from './program.js';

if (isVersionRequest(process.argv.slice(2))) {
  console.log(VERSION);
} else {
  buildProgram().parseAsync(process.argv).catch((err: Error) => {
    console.error(err.message);
    process.exit(1);
  });
}
