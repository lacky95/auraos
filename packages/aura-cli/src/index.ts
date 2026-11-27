import { VERSION, buildProgram, isVersionRequest } from './program.js';
import { EXIT_USAGE, agentUnavailableText, parseInvocation } from './lib/invocation.js';

const args = process.argv.slice(2);
if (isVersionRequest(args)) {
  console.log(VERSION);
} else {
  const program = buildProgram();
  // D109 AF3: `--agent` is reserved (lib/invocation.ts); it never runs an action.
  const invocation = parseInvocation(args, program);
  if (invocation.agent) {
    process.stderr.write(agentUnavailableText(invocation));
    process.exit(EXIT_USAGE);
  }
  program.parseAsync(process.argv).catch((err: Error) => {
    console.error(err.message);
    process.exit(1);
  });
}
