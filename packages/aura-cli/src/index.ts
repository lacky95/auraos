import { VERSION, buildProgram, isVersionRequest } from './program.js';
import { errorJson, exitCodeOf, wantsJsonErrors } from './lib/client.js';

if (isVersionRequest(process.argv.slice(2))) {
  console.log(VERSION);
} else {
  buildProgram().parseAsync(process.argv).catch((err: Error) => {
    console.error(wantsJsonErrors(process.argv.slice(2)) ? errorJson(err) : err.message);
    process.exit(exitCodeOf(err));
  });
}
